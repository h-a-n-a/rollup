import { basename, extname } from './utils/path'
import { Promise } from 'sander'
import MagicString from 'magic-string'
import { blank, keys } from './utils/object'
import Module from './Module'
import ExternalModule from './ExternalModule'
import finalisers from './finalisers/index'
import makeLegalIdentifier from './utils/makeLegalIdentifier'
import ensureArray from './utils/ensureArray'
import { defaultResolver, defaultExternalResolver } from './utils/resolveId'
import { defaultLoader } from './utils/load'
import getExportMode from './utils/getExportMode'
import getIndentString from './utils/getIndentString'
import { unixizePath } from './utils/normalizePlatform.js'

function isEmptyExportedVarDeclaration(node, module, allBundleExports) {
  if (node.type !== 'VariableDeclaration' || node.declarations[0].init)
    return false

  const name = node.declarations[0].id.name
  const canonicalName = module.getCanonicalName(name)

  return canonicalName in allBundleExports
}

export default class Bundle {
  constructor(options) {
    // entry file
    this.entry = options.entry
    // 入口模块
    this.entryModule = null

    // resolver
    this.resolveId = options.resolveId || defaultResolver
    this.load = options.load || defaultLoader

    this.resolveOptions = {
      external: ensureArray(options.external),
      // external resolve
      resolveExternal: options.resolveExternal || defaultExternalResolver,
    }

    this.loadOptions = {
      transform: ensureArray(options.transform),
    }

    this.varExports = blank()
    this.toExport = null

    // 加载模块的 promise
    this.modulePromises = blank() // type: Promise<Module>[]
    // 已经加载过的 Module，后续会根据 modules 判断 modifies 的变量对应依赖是否全部加载
    this.modules = [] // type: Module[]

    this.statements = null
    this.externalModules = []
    // 内部 importStar 的模块（非 External 模块），TODO: 为什么要记录？
    this.internalNamespaceModules = []
    // 认为是全局变量的变量 Record<IdentifierName, boolean>，如 { "alert": true }
    this.assumedGlobals = blank()
  }

  build() {
    return this.fetchModule(this.entry, undefined)
      .then((entryModule) => {
        // 拿到加载过的模块 type: Module
        const defaultExport = entryModule.exports.default

        this.entryModule = entryModule

        // 在当前模块内部做 naming deconflict
        if (defaultExport) {
          // `export default function foo () {...}` -
          // use the declared name for the export
          // 这里有一个 rollup 的 bug，当 declaredName 与 statements 中的 defines 冲突，则会冲突，12-23 更新：deconflict 内部作者说 TODO
          /**
           * Code:
           * export const Foo = {}
             export default class Foo {}

             GenCode:
             const _Foo = {}
             class _Foo {}

             exports.Foo = _Foo;
             exports.default = _Foo;
           */
          if (defaultExport.declaredName) {
            // 添加 suggestName 到 entryModule.suggestedNames 中
            // 语意是建议 default export 的名称为 defaultExport.declaredName
            entryModule.suggestName('default', defaultExport.declaredName)
          }

          // `export default a + b` - generate an export name
          // based on the id of the entry module
          else {
            // 获取 entryModule 的文件名（没有 ext）
            let defaultExportName = makeLegalIdentifier(
              basename(this.entryModule.id).slice(
                0,
                -extname(this.entryModule.id).length
              )
            )

            // deconflict
            let topLevelNames = []
            // 获取当前模块每一个 statement 的 topLevel 定义
            entryModule.statements.forEach((statement) => {
              keys(statement.defines).forEach((name) =>
                topLevelNames.push(name)
              )
            })

            // ~-1 === 0
            // 当 defaultExportName 和 topLevelNames 中的名称冲突时，在 defaultExportName 前添加 _，直到不冲突为止
            while (~topLevelNames.indexOf(defaultExportName)) {
              defaultExportName = `_${defaultExportName}`
            }

            entryModule.suggestName('default', defaultExportName)
          }
        }

        return entryModule.markAllStatements(true)
      })
      .then(() => {
        // 从每一个模块的 modifies 向上查找并 include
        return this.markAllModifierStatements()
      })
      .then(() => {
        // 将所有模块的 statements 合并，并排序（包括循环引用处理，即将强依赖某模块 A 的模块们放在模块 A 最下方引用）
        this.statements = this.sort()
        this.deconflict()
      })
  }

  deconflict() {
    // 定义的变量 Record<Name, Module[]>
    let definers = blank()
    // 冲突的变量 Record<Name, boolean>
    let conflicts = blank()

    // Discover conflicts (i.e. two statements in separate modules both define `foo`)
    this.statements.forEach((statement) => {
      // 当前 statement 和对应 module 内的 statements 做 naming deconflict
      // statement 对应 module
      const module = statement.module
      // statement 的 topLevelVar
      const names = keys(statement.defines)

      // with default exports that are expressions (`export default 42`),
      // we need to ensure that the name chosen for the expression does
      // not conflict
      /**
       * Code: 
       * export default 123
       * 
       * AST:
       * {
          "type": "ExportDefaultDeclaration",
          "start": 0,
          "end": 18,
          "declaration": {
            "type": "Literal",
            "start": 15,
            "end": 18,
            "value": 123,
            "raw": "123"
          }
        }
       */
      if (statement.node.type === 'ExportDefaultDeclaration') {
        // 拿到 export default 的变量名（即使 import 的另外一个模块，也可能拿到一致的名称），如果全局有冲突会重新做 deconflict
        const name = module.getCanonicalName('default') // 获取当前模块 default 的变量名（该变量名也可能是外部模块的）

        const isProxy =
          statement.node.declaration &&
          statement.node.declaration.type === 'Identifier'
        const shouldDeconflict =
          !isProxy /* 非变量，如 export default 123，此时会创建 */ ||
          // 当 default identifier name 与推荐的名称不同时，需要 deconflict，TODO:相同的时候为什么就不用 deconflict？
          module.getCanonicalName(statement.node.declaration.name) !== name

        // 是否需要加入 deconflict 的 names 列表
        if (shouldDeconflict && !~names.indexOf(name)) {
          names.push(name)
        }
      }

      // statement defines + shouldDeconflict 的变量名
      names.forEach((name) => {
        if (definers[name]) {
          conflicts[name] = true
        } else {
          definers[name] = []
        }

        // TODO in good js, there shouldn't be duplicate definitions
        // per module... but some people write bad js
        definers[name].push(module)
      })
    })

    // Assign names to external modules
    this.externalModules.forEach((module) => {
      // TODO is this right?
      let name = makeLegalIdentifier(
        module.suggestedNames['*'] || module.suggestedNames.default || module.id
      )

      if (definers[name]) {
        conflicts[name] = true
      } else {
        definers[name] = []
      }

      definers[name].push(module)
      module.name = name
    })

    // Ensure we don't conflict with globals
    keys(this.assumedGlobals).forEach((name) => {
      // 如果定义了全局变量中的值，则存到冲突变量中
      if (definers[name]) {
        conflicts[name] = true
      }
    })

    // Rename conflicting identifiers so they can live in the same scope
    keys(conflicts).forEach((name) => {
      const modules = definers[name]

      if (!this.assumedGlobals[name]) {
        // the module closest to the entryModule gets away with
        // keeping things as they are, unless we have a conflict
        // with a global name
        modules.pop()
      }

      modules.forEach((module) => {
        const replacement = getSafeName(name)
        // 如果有命名冲突则替换新名字
        module.rename(name, replacement)
      })
    })

    function getSafeName(name) {
      while (conflicts[name]) {
        name = `_${name}`
      }

      conflicts[name] = true
      return name
    }
  }

  fetchModule(importee, importer) {
    return Promise.resolve(
      // 读取模块
      this.resolveId(importee, importer, this.resolveOptions)
    ).then((id) => {
      // 外部模块返回 id = null
      if (!id) {
        // external module
        // 没有加载则加载
        if (!this.modulePromises[importee]) {
          const module = new ExternalModule(importee)
          this.externalModules.push(module)
          this.modulePromises[importee] = Promise.resolve(module)
        }

        return this.modulePromises[importee]
      }

      // 非外部模块，且没有加载
      if (!this.modulePromises[id]) {
        // 那么用 loader 加载它（读取源码），有需要还会在 loader 里做 transform
        this.modulePromises[id] = Promise.resolve(
          this.load(id, this.loadOptions)
        ).then((source) => {
          // 拿到读取后的模块，parse -> analyse
          const module = new Module({
            id,
            source,
            bundle: this,
          })

          // 放到加载后的模块中，
          this.modules.push(module)

          return module
        })
      }

      // 已经加载过了，直接返回
      return this.modulePromises[id]
    })
  }

  generate(options = {}) {
    let magicString = new MagicString.Bundle({ separator: '' })

    const format = options.format || 'es6'

    // If we have named exports from the bundle, and those exports
    // are assigned to *within* the bundle, we may need to rewrite e.g.
    //
    //   export let count = 0;
    //   export function incr () { count++ }
    //
    // might become...
    //
    //   exports.count = 0;
    //   function incr () {
    //     exports.count += 1;
    //   }
    //   exports.incr = incr;
    //
    // This doesn't apply if the bundle is exported as ES6!
    let allBundleExports = blank()

    if (format !== 'es6') {
      keys(this.entryModule.exports).forEach((key) => {
        const exportDeclaration = this.entryModule.exports[key]

        const originalDeclaration = this.entryModule.findDeclaration(
          exportDeclaration.localName
        )

        if (
          originalDeclaration &&
          originalDeclaration.type === 'VariableDeclaration'
        ) {
          const canonicalName = this.entryModule.getCanonicalName(
            exportDeclaration.localName
          )

          // canonicalName（经过 naming deconflict 之后，该名称为整个 bundle 唯一） 对应的导出语句
          allBundleExports[canonicalName] = `exports.${key}`
          // 记录导出的 variable
          this.varExports[key] = true
        }
      })
    }

    // since we're rewriting variable exports, we want to
    // ensure we don't try and export them again at the bottom
    this.toExport = keys(this.entryModule.exports).filter(
      (key) => !this.varExports[key]
    )

    // Apply new names and add to the output bundle
    let previousModule = null
    let previousIndex = -1
    let previousMargin = 0

    // 遍历整个 statements 列表，根据 canonicalName 结合导出语句开始替换 statement 下的变量
    this.statements.forEach((statement) => {
      // skip `export { foo, bar, baz }`
      if (statement.node.type === 'ExportNamedDeclaration') {
        // skip `export { foo, bar, baz }`
        if (statement.node.specifiers.length) return

        // skip `export var foo;` if foo is exported
        if (
          isEmptyExportedVarDeclaration(
            statement.node.declaration,
            statement.module,
            allBundleExports
          )
        )
          return
      }

      // skip empty var declarations for exported bindings
      // (otherwise we're left with `exports.foo;`, which is useless)
      if (
        isEmptyExportedVarDeclaration(
          statement.node,
          statement.module,
          allBundleExports
        )
      )
        return

      // statement 需要替换的变量 Record<本地变量，Bundle 唯一变量 | 也可能是导出语句，如 "exports.foo">
      let replacements = blank()
      let bundleExports = blank()

      keys(statement.dependsOn)
        .concat(keys(statement.defines))
        .forEach((name) => {
          const canonicalName = statement.module.getCanonicalName(name)

          // 如果已经有导出的语句则直接使用，如 target !== es6
          /**
           * //   export let count = 0;
             //   export function incr () { count++ }
             //
             //   将会变成⬇️
             //
             //   exports.count = 0;
             //   function incr () {
             //     exports.count += 1; // 这里直接使用了 allBundleExports 的语句
             //   }
             //   exports.incr = incr;
           */
          if (allBundleExports[canonicalName]) {
            // 1. bundleExports TODO:
            // 2. replacements: 如果canonicalName 对应整个 Bundle 的导出语句，则未来替换时需要替换成它
            bundleExports[name] = replacements[name] =
              allBundleExports[canonicalName]
          } else if (name !== canonicalName) {
            replacements[name] = canonicalName
          }
        })
      // 至此，已经拿到了当前 statement 内部需要替换的变量

      // 递归这个 statement 下的节点开始替换
      const source = statement.replaceIdentifiers(replacements, bundleExports)

      // modify exports as necessary
      if (statement.isExportDeclaration) {
        // remove `export` from `export var foo = 42`
        if (
          statement.node.type === 'ExportNamedDeclaration' &&
          statement.node.declaration.type === 'VariableDeclaration'
        ) {
          source.remove(statement.node.start, statement.node.declaration.start)
        }

        // remove `export` from `export class Foo {...}` or `export default Foo`
        // TODO default exports need different treatment
        else if (statement.node.declaration.id) {
          source.remove(statement.node.start, statement.node.declaration.start)
        } else if (statement.node.type === 'ExportDefaultDeclaration') {
          const module = statement.module
          const canonicalName = module.getCanonicalName('default')

          if (
            statement.node.declaration.type === 'Identifier' &&
            canonicalName ===
              module.getCanonicalName(statement.node.declaration.name)
          ) {
            return
          }

          // anonymous functions should be converted into declarations
          if (statement.node.declaration.type === 'FunctionExpression') {
            source.overwrite(
              statement.node.start,
              statement.node.declaration.start + 8,
              `function ${canonicalName}`
            )
          } else {
            source.overwrite(
              statement.node.start,
              statement.node.declaration.start,
              `var ${canonicalName} = `
            )
          }
        } else {
          throw new Error('Unhandled export')
        }
      }

      // ensure there is always a newline between statements, and add
      // additional newlines as necessary to reflect original source
      const minSeparation =
        previousModule !== statement.module ||
        statement.index !== previousIndex + 1
          ? 3
          : 2
      const margin = Math.max(
        minSeparation,
        statement.margin[0],
        previousMargin
      )
      let newLines = new Array(margin).join('\n')

      // add leading comments
      if (statement.leadingComments.length) {
        const commentBlock =
          newLines +
          statement.leadingComments
            .map(({ separator, comment }) => {
              return (
                separator +
                (comment.block ? `/*${comment.text}*/` : `//${comment.text}`)
              )
            })
            .join('')

        magicString.addSource(new MagicString(commentBlock))
        newLines = new Array(statement.margin[0]).join('\n') // TODO handle gaps between comment block and statement
      }

      // add the statement itself
      magicString.addSource({
        content: source,
        separator: newLines,
      })

      // add trailing comments
      const comment = statement.trailingComment
      if (comment) {
        const commentBlock = comment.block
          ? ` /*${comment.text}*/`
          : ` //${comment.text}`

        magicString.append(commentBlock)
      }

      previousMargin = statement.margin[1]
      previousModule = statement.module
      previousIndex = statement.index
    })

    // prepend bundle with internal namespaces
    const indentString = magicString.getIndentString()
    const namespaceBlock = this.internalNamespaceModules
      .map((module) => {
        const exportKeys = keys(module.exports)

        return (
          `var ${module.getCanonicalName('*')} = {\n` +
          exportKeys
            .map(
              (key) =>
                `${indentString}get ${key} () { return ${module.getCanonicalName(
                  key
                )}; }`
            )
            .join(',\n') +
          `\n};\n\n`
        )
      })
      .join('')

    magicString.prepend(namespaceBlock)

    const finalise = finalisers[format]

    if (!finalise) {
      throw new Error(
        `You must specify an output type - valid options are ${keys(
          finalisers
        ).join(', ')}`
      )
    }

    magicString = finalise(
      this,
      magicString.trim(),
      {
        // Determine export mode - 'default', 'named', 'none'
        exportMode: getExportMode(this, options.exports),

        // Determine indentation
        indentString: getIndentString(magicString, options),
      },
      options
    )

    const code = magicString.toString()
    let map = null

    if (options.sourceMap) {
      const file = options.sourceMapFile || options.dest
      map = magicString.generateMap({
        includeContent: true,
        file,
        // TODO
      })

      map.sources = map.sources.map(unixizePath)
    }

    return { code, map }
  }

  markAllModifierStatements() {
    // TODO: 看起来 settled 为 false 就会重新再找一遍，再找一遍会有什么不同？
    let settled = true
    let promises = []

    // 遍历模块（this.modules 只包含了被 fetchModule(除了 entryModule 以外需要被 module mark(通过 import)) 的模块，没有 fetch 的模块不需要纳入依赖图）
    this.modules.forEach((module) => {
      module.statements.forEach((statement) => {
        // 如果 statement isIncluded 就表明已经做过了读写检查，不需要再次检查，否则需要根据 modifies 在重新扫描一遍 graph
        if (statement.isIncluded) return

        // 获取 statement 中对变量的修改
        keys(statement.modifies).forEach((name) => {
          // modifies 的内容，不是在当前模块中，那就是在 importee 的模块中，要么就是在全局环境
          const definingStatement = module.definitions[name] // 找到 module 中定义这个变量的 statement，也可能是其他 module 的，那之后要去找 import 里的
          const exportDeclaration = module.exports[name] // 找到 module 中定义这个变量的 export，（export { a, b, c } 这种是没有 statement 的），也可能是其他 module 的，那之后要去找 import 里的

          const shouldMark =
            (definingStatement &&
              definingStatement.isIncluded) /* 定义这个变量的 statement 是否被 mark */ ||
            (exportDeclaration && exportDeclaration.isUsed)

          if (shouldMark) {
            settled = false
            promises.push(statement.mark())
            return
          }

          // special case - https://github.com/rollup/rollup/pull/40
          const importDeclaration = module.imports[name] // 当前模块的 import，这里的 name 一定是 import 的 localName，当然 statement.modifies 里也一定是 localName
          if (!importDeclaration) return // 也许是对全局变量上的修改，因此我们需要跳过

          const promise = Promise.resolve(
            // mark 过的 import 则会有 module 这个字段，如果没有就 fetchModule
            importDeclaration.module ||
              this.fetchModule(importDeclaration.source, module.id)
          )
            .then((module) => {
              // fetch 完在加上去
              importDeclaration.module = module
              // 当前 module 的 importDeclaration 的 name 其实就等于 importee 的 module exports 中的 name
              // 但在 namespacedImport 中 name 为 *，但 module.exports 内部其实是没有 * 导出的，可能是一个 bad case?
              const exportDeclaration = module.exports[importDeclaration.name]
              // TODO things like `export default a + b` don't apply here... right?
              return module.findDefiningStatement(exportDeclaration.localName)
            })
            .then((definingStatement) => {
              if (!definingStatement) return

              settled = false
              return statement.mark()
            })

          promises.push(promise)
        })
      })
    })

    return Promise.all(promises).then(() => {
      if (!settled) return this.markAllModifierStatements()
    })
  }

  // sort module
  sort() {
    let seen = {}
    let ordered = []
    let hasCycles

    let strongDeps = {}
    let stronglyDependsOn = {}

    function visit(module) {
      seen[module.id] = true

      // 找到当前模块对于非 ExternalModule 的 import 的强弱依赖
      const { strongDependencies, weakDependencies } =
        module.consolidateDependencies()

      // 语意：Record<模块ID，强依赖的模块[]>
      strongDeps[module.id] = []
      // hashmap 语意：Record<模块ID, Record<依赖的模块ID, bool>>
      stronglyDependsOn[module.id] = {}

      keys(strongDependencies).forEach((id) => {
        const imported = strongDependencies[id]

        strongDeps[module.id].push(imported)

        if (seen[id]) {
          // we need to prevent an infinite loop, and note that
          // we need to check for strong/weak dependency relationships
          hasCycles = true
          return
        }

        visit(imported)
      })

      keys(weakDependencies).forEach((id) => {
        const imported = weakDependencies[id]

        if (seen[id]) {
          // we need to prevent an infinite loop, and note that
          // we need to check for strong/weak dependency relationships
          hasCycles = true
          return
        }

        visit(imported)
      })

      // add second (and third...) order dependencies
      function addStrongDependencies(dependency) {
        if (stronglyDependsOn[module.id][dependency.id]) return

        // 记录 module.id 依赖的 dependency.id
        stronglyDependsOn[module.id][dependency.id] = true
        // 反过来再记录 dependency.id 依赖的依赖的 ID
        strongDeps[dependency.id].forEach(addStrongDependencies)
      }

      strongDeps[module.id].forEach(addStrongDependencies)

      // push 模块顺序
      ordered.push(module)
    }

    // 根据依赖关系自上而下递归插入模块
    visit(this.entryModule)

    // 循环引用的处理
    if (hasCycles) {
      let unordered = ordered
      ordered = []

      // unordered is actually semi-ordered, as [ fewer dependencies ... more dependencies ]
      unordered.forEach((module) => {
        // 在放置依赖 A 的模块时，先放置不强依赖 A 的模块们
        // ensure strong dependencies of `module` that don't strongly depend on `module` go first
        strongDeps[module.id].forEach(place)

        function place(dep) {
          if (!stronglyDependsOn[dep.id][module.id] && !~ordered.indexOf(dep)) {
            strongDeps[dep.id].forEach(place)
            ordered.push(dep)
          }
        }

        if (!~ordered.indexOf(module)) {
          ordered.push(module)
        }
      })
    }

    let statements = []

    // 只添加被 mark(included) 的 statement
    ordered.forEach((module) => {
      module.statements.forEach((statement) => {
        if (statement.isIncluded) statements.push(statement)
      })
    })

    return statements
  }
}
