import { dirname } from './utils/path'
import { Promise } from 'sander'
import { parse } from 'acorn'
import MagicString from 'magic-string'
import Statement from './Statement'
import walk from './ast/walk'
import analyse from './ast/analyse'
import { blank, keys } from './utils/object'
import { sequence } from './utils/promise'
import { isImportDeclaration, isExportDeclaration } from './utils/map-helpers'
import getLocation from './utils/getLocation'
import makeLegalIdentifier from './utils/makeLegalIdentifier'

const emptyArrayPromise = Promise.resolve([])

function deconflict(name, names) {
  while (name in names) {
    name = `_${name}`
  }

  return name
}

export default class Module {
  constructor({ id, source, bundle }) {
    // 实例化的时候先拿到所有 statements 然后再得到 import / export
    // 模块源码
    this.source = source

    // 对应模块所属 bundle
    this.bundle = bundle // type: Bundle

    // 模块 ID （绝对路径）
    this.id = id

    // By default, `id` is the filename. Custom resolvers and loaders
    // can change that, but it makes sense to use it for the source filename
    // 模块对应 magicString，未来用于生成 sourcemap
    this.magicString = new MagicString(source, {
      filename: id,
    })

    // 导出的推荐名称 Record<"*" | "default", SuggestedName>，同时会作为模块中变量的 localName
    this.suggestedNames = blank()
    // 模块内部注释
    this.comments = []

    // 初始化则直接解析，得到模块内部的语句 对应 Rollup 的 type: Statement，但不做进一步分析，只是获取 statement 的 rawData（还没有开始做分析）
    this.statements = this._parse()

    // imports and exports, indexed by ID
    /** // 对应 import foo from './foo'
     * Record<LocalName, {
        source: "./foo",  请求的文件
        name: "default",  请求的变量，(这里还可以是 *，如 import * foo from "./foo")
        localName: "foo", 当前模块中的变量
        module: Module // new Module 的时候不会添加，会在之后 markAllStatemen 的时候添加
       }>
     */
    this.imports = blank()
    // 当 export { a,b,c } 的时候 statement 字段不存在
    // Record<ExportedName, {...}> // 注意这里不是 localName 了
    this.exports = blank()
    // TODO
    this.canonicalNames = blank()
    // 模块中变量的定义 Record<IdentifierName, Statement>
    this.definitions = blank()
    // 和上述字段不同的是，上述字段仅仅定义了模块内部的变量，但对于该变量背后的依赖(statement.dependsOn/statement.stronglyDependsOn) 依旧是没有解析的
    // definitionPromise 为 statement.mark() 返回值所组成的 object
    // type: Record<IdentifierName, Promise<ReturnType<Statement['mark']>>>
    this.definitionPromises = blank()
    // 模块中对于某一个变量的修改（这个变量可能不是来自于该 Statement，可能只是被这个 Statement 内部修改了） Record<IdentifierName, Statement>
    this.modifications = blank()

    // 分析当前模块 statements imports / exports / 读写 / definitions / modifications / comments
    this.analyse()
  }
  // AST see: https://astexplorer.net/#/gist/a955d296188772d0a3974c12ae7b83c1/9fef71b1e1d7c067c64e697730b65fef501cf949
  addExport(statement) {
    const node = statement.node // type: ExportNamedDeclaration | ExportDefaultDeclaration
    const source = node.source && node.source.value // type: "ExportNamedDeclaration" | "ExportDefaultDeclaration"

    // export default function foo () {}
    // export default foo;
    // export default 42;
    if (node.type === 'ExportDefaultDeclaration') {
      // 是否为声明
      const isDeclaration = /Declaration$/.test(node.declaration.type)
      // 匿名：但测了一下发现只有 export default () => {} 才满足这个情况（ArrowFunctionExpression），似乎和 acorn 的版本有关？TODO: 测试一下
      const isAnonymous = /(?:Class|Function)Expression$/.test(
        node.declaration.type
      )

      // 综合看，在这个版本的 acorn 中，只要是 declaration 就一定有 name，TODO: 是这样吗？
      const declaredName = isDeclaration && node.declaration.id.name // export default function foo() {}; 则 declaredName 为 foo
      const identifier = // export default a; 则 identifier 为 a
        node.declaration.type === 'Identifier' && node.declaration.name

      this.exports.default = {
        statement,
        name: 'default',
        localName: declaredName || 'default',
        declaredName,
        identifier,
        isDeclaration,
        isAnonymous,
        isModified: false, // in case of `export default foo; foo = somethingElse`
      }
    }

    // export { foo, bar, baz }
    // export var foo = 42;
    // export function foo () {}
    else if (node.type === 'ExportNamedDeclaration') {
      if (node.specifiers.length) {
        // 为 named declaration 分别添加导出
        // export { foo, bar, baz }
        node.specifiers.forEach((specifier) => {
          const localName = specifier.local.name
          const exportedName = specifier.exported.name

          // 为 foo, bar, baz 都分别加上的 declaration
          this.exports[exportedName] = {
            localName,
            exportedName,
          }

          // export { foo } from './foo';
          if (source) {
            this.imports[localName] = {
              source,
              localName,
              name: localName,
            }
          }
        })
      } else {
        let declaration = node.declaration

        let name

        if (declaration.type === 'VariableDeclaration') {
          // export var foo = 42
          name = declaration.declarations[0].id.name
        } else {
          // export function foo () {}
          name = declaration.id.name
        }

        this.exports[name] = {
          statement,
          localName: name,
          expression: declaration,
        }
      }
    }
  }
  // AST see: https://astexplorer.net/#/gist/a955d296188772d0a3974c12ae7b83c1/latest
  addImport(statement) {
    const node = statement.node // type: ImportDeclaration Node
    const source = node.source.value // request id
    // specifier 表示 import 与 from 之间的东西，source 表示 from 之后的东西(request module)
    // import { foo as NewFoo, bar as NewBar } from "./foo" 则每一个 `foo as NewFoo` 都是一个 specifier
    node.specifiers.forEach((specifier) => {
      const isDefault = specifier.type === 'ImportDefaultSpecifier' // import foo from "./foo"
      const isNamespace = specifier.type === 'ImportNamespaceSpecifier' // import * as foo from "./foo"
      // 该字段一定存在（否则就是语法错误了），当前模块中的 namespace 例如 import * as foo from "./foo"，则这个是 foo，import foo from "./foo" 则也是 foo
      const localName = specifier.local.name
      const name = isDefault // requested module 中 exported 的变量
        ? 'default'
        : isNamespace
        ? '*'
        : specifier.imported.name
      /** 
       * import { foo as NewFoo } from "./foo"
       * {
      "type": "ImportDeclaration",
      "start": 0,
      "end": 38,
      "specifiers": [
        {
          "type": "ImportSpecifier",
          "start": 9,
          "end": 22,
          "imported": {
            "type": "Identifier",
            "start": 9,
            "end": 12,
            "name": "foo" // requested module 中 exported 的变量
          },
          "local": {
            "type": "Identifier",
            "start": 16,
            "end": 22,
            "name": "NewFoo" // 本地变量
          }
        }
      ],
      "source": {
        "type": "Literal",
        "start": 30,
        "end": 37,
        "value": "./foo",
        "raw": "'./foo'"
      }
    },
       */

      // 重复的 import localname 则会报错，因为不允许两个相同的变量名存在与一个模块作用域内
      if (this.imports[localName]) {
        const err = new Error(`Duplicated import '${localName}'`)
        err.file = this.id
        err.loc = getLocation(this.source, specifier.start)
        throw err // 报错位置
      }
      // 没有报错则直接添加到 imports
      this.imports[localName] = {
        source,
        name,
        localName,
      }
    })
  }
  // 通过拿到的 statements 原数据，进一步分析 import export 的依赖图，以及做作用域分析（创建作用域链）
  analyse() {
    // discover this module's imports and exports
    this.statements.forEach((statement) => {
      if (isImportDeclaration(statement)) this.addImport(statement)
      else if (isExportDeclaration(statement)) this.addExport(statement)
    })
    // comment 归属分析，作用域分析
    analyse(this.magicString, this)

    // consolidate names that are defined/modified in this module
    this.statements.forEach((statement) => {
      // 同步 statement topLevelNames 到模块定义
      keys(statement.defines).forEach((name) => {
        this.definitions[name] = statement
      })

      // 同步 statement modifies 到模块 modifications
      keys(statement.modifies).forEach((name) => {
        ;(this.modifications[name] || (this.modifications[name] = [])).push(
          statement
        )
      })
    })

    // if names are referenced that are neither defined nor imported
    // in this module, we assume that they're globals
    this.statements.forEach((statement) => {
      keys(statement.dependsOn).forEach((name) => {
        if (!this.definitions[name] && !this.imports[name]) {
          // 在整个 bundle 中添加 name 为全局变量
          this.bundle.assumedGlobals[name] = true
        }
      })
    })
  }

  // 获取一个模块对于 import Module(not ExternalModule) 的强弱依赖
  consolidateDependencies() {
    // Record<ModuleId, Module>
    let strongDependencies = blank()

    this.statements.forEach((statement) => {
      // import {} from "./foo" or import "./foo"
      if (statement.isImportDeclaration && !statement.node.specifiers.length) {
        // include module for its side-effects
        strongDependencies[statement.module.id] = statement.module // TODO is this right? `statement.module` should be `this`, surely?
      }

      // 找到强依赖模块
      keys(statement.stronglyDependsOn).forEach((name) => {
        // 如果是当前 statement 定义过的，例如 function foo() { console.log(foo) } 则跳过
        if (statement.defines[name]) return

        const importDeclaration = this.imports[name]

        // 找到所有非 External 模块的 import 引用
        if (
          importDeclaration &&
          importDeclaration.module &&
          !importDeclaration.module.isExternal
        ) {
          strongDependencies[importDeclaration.module.id] =
            importDeclaration.module
        }
      })
    })

    let weakDependencies = blank()

    this.statements.forEach((statement) => {
      keys(statement.dependsOn).forEach((name) => {
        if (statement.defines[name]) return

        const importDeclaration = this.imports[name]

        // 找到所有非 External 模块的 import 引用
        if (
          importDeclaration &&
          importDeclaration.module &&
          !importDeclaration.module.isExternal
        ) {
          weakDependencies[importDeclaration.module.id] =
            importDeclaration.module
        }
      })
    })

    return { strongDependencies, weakDependencies }
  }

  findDefiningStatement(name) {
    // 在模块中定义了，则直接返回
    if (this.definitions[name]) return this.definitions[name]

    // TODO what about `default`/`*`? 笑死，作者也想到了 default / * 的 case

    // 当然这个 name 一定是 localName
    const importDeclaration = this.imports[name]
    if (!importDeclaration) return null // 找不到就说明可能是全局变量，跳过

    // 在请求当前模块中的 import
    return Promise.resolve(
      importDeclaration.module ||
        this.bundle.fetchModule(importDeclaration.source, this.id)
    ).then((module) => {
      // 把 importee 加到当前模块的 imports map 引用中
      importDeclaration.module = module
      // 然后再去 importee 这个模块中查找这个 name，但这个 name 是不是应该写成 importDeclaration.name？即为那边的 localName
      return module.findDefiningStatement(name)
    })
  }

  findDeclaration(localName) {
    const importDeclaration = this.imports[localName]

    // name was defined by another module
    if (importDeclaration) {
      const module = importDeclaration.module

      if (module.isExternal) return null

      const exportDeclaration = module.exports[importDeclaration.name]
      return module.findDeclaration(exportDeclaration.localName)
    }

    // name was defined by this module, if any
    let i = this.statements.length
    while (i--) {
      const declaration = this.statements[i].scope.declarations[localName]
      if (declaration) {
        return declaration
      }
    }

    return null
  }

  // 这是很重要的一步，将模块间的导入导出变量名（TODO: 现在看起来是 ID 的关系）在模块间均保持统一，TODO: 这个似乎只是一个全局唯一的 ID？但实际 generate 的似乎是原始的名称？需要再看看
  // 之所以能保持统一，是因为某一个模块的 default/* 导出的名称只能被 suggest 一次，下一次再被 suggest 依旧拿到的是之前 suggest 后的名称
  // 获取当前模块的 localName 与模块中对应变量名的映射关系
  // 由于当前模块中的 localName 可能指向着另一个 import，所以这里要递归调用，以确保 scope hositing 之后的变量名与对应的模块中的变量名保持统一
  getCanonicalName(localName) {
    // Special case
    if (
      localName === 'default' &&
      (this.exports.default.isModified || !this.suggestedNames.default)
    ) {
      let canonicalName = makeLegalIdentifier(
        this.id
          .replace(dirname(this.bundle.entryModule.id) + '/', '')
          .replace(/\.js$/, '')
      )
      return deconflict(canonicalName, this.definitions)
    }

    if (this.suggestedNames[localName]) {
      // Record<localName, suggestedName>，通过模块中的导出名称，获取模块中推荐的 localName
      // 例如 export default function foo() {} 被 import abc from "./foo" 了以后，首先给 foo 的 default export 推荐了 abc 作为变量名，因此 var abc = function foo() {}
      localName = this.suggestedNames[localName]
    }

    if (!this.canonicalNames[localName]) {
      let canonicalName

      // 如果获取的 localName 是 import 的模块的，那么我们需要递归
      if (this.imports[localName]) {
        const importDeclaration = this.imports[localName]
        // importee module
        const module = importDeclaration.module

        if (importDeclaration.name === '*') {
          // module.mark 处 suggest
          // 此处不关心 bundle 维度的命名重复，会在 bundle 中处理
          canonicalName = module.suggestedNames['*']
          // 其实这里也可以像下面一样调用一遍 module.getCanonicalName('*')，但这里导出的是全部，因此直接把 * 对应的本地变量名做为 canonicalName
        } else {
          // importee 的 localName
          let exporterLocalName

          if (module.isExternal) {
            // 外部模块直接用 importee localName
            exporterLocalName = importDeclaration.name
          } else {
            // 否责查找 module.exports 内的定义
            const exportDeclaration = module.exports[importDeclaration.name]
            exporterLocalName = exportDeclaration.localName
          }

          // 获取 importee localName 的 canonicalName，并递归查找变量名的定义
          canonicalName = module.getCanonicalName(exporterLocalName)
        }
      } else {
        // 如果获取的 localName 不是 import map 中的，则表示为当前模块变量
        canonicalName = localName
      }

      this.canonicalNames[localName] = canonicalName
    }

    return this.canonicalNames[localName]
  }

  // 请求变量（如 statement 依赖中依赖了某些外部变量），如果这个变量存在于其他模块，则先请求模块
  // resolve 之后则表示该变量已经被分析
  mark(name) {
    // 同一个 promise 不会 resolve 两次，因此我们这里直接返回一个 resolved 的 promise
    // shortcut cycles. TODO this won't work everywhere...
    if (this.definitionPromises[name]) {
      return emptyArrayPromise
    }

    let promise

    // The definition for this name is in a different module
    // 当请求的变量依赖其他模块，则递归请求模块，下面的 importee localName suggestion 均为当前模块的 localName 作为 suggestion，期望与当前模块的一致
    if (this.imports[name]) {
      const importDeclaration = this.imports[name]

      promise = this.bundle
        .fetchModule(importDeclaration.source, this.id)
        .then((module /* 被 import 的模块 */) => {
          importDeclaration.module = module // 可能有两种类型，ExternalModule, Module

          // 处理被 import 的模块的 export
          // suggest names. TODO should this apply to non default/* imports?
          // 当 import 对应模块的 default 值时，使用当前模块的 localName 为基准做 importee 的 default declaration name 推荐
          if (importDeclaration.name === 'default') {
            // TODO this seems ropey
            // 当前模块引用的本地变量名
            const localName = importDeclaration.localName
            // 检查当前模块有没有对 localName 提议新的名字， 不然就提议使用 localName
            let suggestion = this.suggestedNames[localName] || localName

            // special case - the module has its own import by this name
            // 防止 imported 的模块内部的 defaultDeclaration 和 import declaration 冲突
            // 当被 import 的模块本身也有 suggestion 名字的 import，则修改被 import 模块的 suggestion 名字
            while (!module.isExternal && module.imports[suggestion]) {
              suggestion = `_${suggestion}`
            }

            // 设定被 import 的模块中的 default 名字，以解决被 import 的模块的 default 与现在的模块的 default 冲突的问题
            module.suggestName('default', suggestion)
          } else if (importDeclaration.name === '*') {
            // importStar 的情况 (ImportNamespaceSpecifier)
            // 用当前模块的 localName 为基准做 importee 的 namedExport 的 declaration name 推荐
            const localName = importDeclaration.localName
            const suggestion = this.suggestedNames[localName] || localName
            // batch import
            module.suggestName('*', suggestion)
            module.suggestName('default', `${suggestion}__default`)
          }

          // ExternalModule
          if (module.isExternal) {
            if (importDeclaration.name === 'default') {
              module.needsDefault = true
            } else {
              module.needsNamed = true
            }
            // ExternalModule
            module.importedByBundle.push(importDeclaration)
            return emptyArrayPromise
          }

          if (importDeclaration.name === '*') {
            // we need to create an internal namespace
            // 将 importStar 的模块添加到 bundle.internalNamespaces 中（没添加过才添加），TODO: 为什么要这么做？
            if (!~this.bundle.internalNamespaceModules.indexOf(module)) {
              this.bundle.internalNamespaceModules.push(module)
            }

            // 并且递归 include 所有 module.statements 以及其依赖
            return module.markAllStatements()
          }

          const exportDeclaration = module.exports[importDeclaration.name]

          if (!exportDeclaration) {
            throw new Error(
              `Module ${module.id} does not export ${importDeclaration.name} (imported by ${this.id})`
            )
          }

          // 请求 importee 的 exported 变量
          return module.mark(exportDeclaration.localName)
        })
    }

    // 请求这个模块的 default 字段（可能是另一个模块发来的请求），那我们就再递归请求一次 default 对应的 declaration name
    // The definition is in this module
    else if (name === 'default' && this.exports.default.isDeclaration) {
      // We have something like `export default foo` - so we just start again,
      // searching for `foo` instead of default
      promise = this.mark(this.exports.default.name)
    } else {
      let statement

      // 先定位这个变量在当前模块中的哪一个 statement
      statement =
        name === 'default'
          ? this.exports.default.statement
          : this.definitions[name]
      promise =
        statement && !statement.isIncluded // 如果没有 include 过（statement.mark），则请求 statement 对应 dependency
          ? statement.mark()
          : emptyArrayPromise

      // Special case - `export default foo; foo += 1` - need to be
      // vigilant about maintaining the correct order of the export
      // declaration. Otherwise, the export declaration will always
      // go at the end of the expansion, because the expansion of
      // `foo` will include statements *after* the declaration
      if (
        name === 'default' &&
        this.exports.default.identifier &&
        this.exports.default.isModified
      ) {
        const defaultExportStatement = this.exports.default.statement
        promise = promise.then((statements) => {
          // remove the default export statement...
          // TODO could this be statements.pop()?
          statements.splice(statements.indexOf(defaultExportStatement), 1)

          let i = statements.length
          let inserted = false

          // 特殊情况将 defaultExport 插入对应的位置
          while (i--) {
            if (
              statements[i].module === this &&
              statements[i].index < defaultExportStatement.index
            ) {
              statements.splice(i + 1, 0, defaultExportStatement)
              inserted = true
              break
            }
          }

          if (!inserted) statements.push(statement)
          return statements
        })
      }
    }

    this.definitionPromises[name] = promise || emptyArrayPromise
    return this.definitionPromises[name]
  }

  markAllStatements(isEntryModule) {
    return sequence(this.statements, (statement) => {
      if (statement.isIncluded) return // TODO can this happen? probably not...

      // 对于 bail imports `import "./abc"` or `import {} from "./foo"` 我们认为是有副作用的，因此直接 fetch 对应模块
      // skip import declarations...
      if (statement.isImportDeclaration) {
        // eg: `import "./foo"` or `import {} from "./foo"`，此时 specifiers 为空
        // ...unless they're empty, in which case assume we're importing them for the side-effects
        // THIS IS NOT FOOLPROOF. Probably need /*rollup: include */ or similar
        if (!statement.node.specifiers.length) {
          return this.bundle
            .fetchModule(statement.node.source.value, this.id)
            .then((module) => {
              statement.module = module
              return module.markAllStatements()
            })
        }

        return
      }

      // skip `export { foo, bar, baz }`...
      if (
        statement.node.type === 'ExportNamedDeclaration' &&
        statement.node.specifiers.length
      ) {
        // ...but ensure they are defined, if this is the entry module
        if (isEntryModule) {
          return statement.mark()
        }

        return
      }

      // include everything else
      return statement.mark()
    })
  }

  // TODO rename this to parse, once https://github.com/rollup/rollup/issues/42 is fixed
  // 解析模块源码生成当前模块的 Statement (内部包括了作用域，statement 所属模块，statement 的索引)
  _parse() {
    // Try to extract a list of top-level statements/declarations. If
    // the parse fails, attach file info and abort
    let ast

    try {
      // 根据源码生成 AST
      ast = parse(this.source, {
        ecmaVersion: 6,
        sourceType: 'module',
        onComment: (block, text, start, end) =>
          this.comments.push({ block, text, start, end }), // 特殊处理：注释单独对待
      })
    } catch (err) {
      err.code = 'PARSE_ERROR'
      err.file = this.id // see above - not necessarily true, but true enough
      throw err
    }

    // 遍历 AST，对所有节点做 sourcemap 上的切割（magicString 做的事情），这样每一条语句都 **最少** 对应了一个 mapping
    walk(ast, {
      enter: (node) => {
        this.magicString.addSourcemapLocation(node.start)
        this.magicString.addSourcemapLocation(node.end)
      },
    })

    // 存放解析出来的 statements
    let statements = []

    // 解析所有 statement ，未来再分析 statement 内部（例如对外部变量的 modify 与引用）
    ast.body.map((node) => {
      //
      // 例如有多个连续的 var a = 1, b = 2 则需要拆分，不然无法做 treeshaking
      /**
       * {
      "type": "VariableDeclaration",
      "start": 54,
      "end": 71,
      "kind": "var",
      "declarations": [
        {
          "type": "VariableDeclarator",
          "start": 58,
          "end": 63,
          "id": {
            "type": "Identifier",
            "start": 58,
            "end": 59,
            "name": "a"
          },
          "init": {
            "type": "Literal",
            "start": 62,
            "end": 63,
            "value": 1,
            "raw": "1"
          }
        },
        {
          "type": "VariableDeclarator",
          "start": 65,
          "end": 70,
          "id": {
            "type": "Identifier",
            "start": 65,
            "end": 66,
            "name": "b"
          },
          "init": {
            "type": "Literal",
            "start": 69,
            "end": 70,
            "value": 2,
            "raw": "2"
          }
        }
      ]
       */

      // special case - top-level var declarations with multiple declarators
      // should be split up. Otherwise, we may end up including code we
      // don't need, just because an unwanted declarator is included
      if (
        node.type === 'VariableDeclaration' &&
        node.declarations.length > 1 /* 连续 declarations */
      ) {
        node.declarations.forEach((declarator) => {
          // var a = 1, b = 2; => var a = 1; var b = 2;
          const magicString = this.magicString
            .snip(declarator.start, declarator.end) // 切割源码留下 a = 1
            .trim()
          magicString.prepend(`${node.kind} `).append(';')

          // 创建单个 declaration 的 VariableDeclaration
          const syntheticNode = {
            type: 'VariableDeclaration',
            kind: node.kind,
            start: node.start,
            end: node.end,
            declarations: [declarator],
          }

          // 创建一条 Rollup Statement
          const statement = new Statement(
            syntheticNode, // acorn
            magicString, // 当前模块切分出 var 定义的 magicString（snip）
            this,
            statements.length
          )
          statements.push(statement)
        })
      } else {
        const magicString = this.magicString.snip(node.start, node.end).trim()
        const statement = new Statement(
          node,
          magicString,
          this,
          statements.length
        )

        statements.push(statement)
      }
    })

    return statements
  }

  // 更换 canonicalNames
  rename(name, replacement) {
    this.canonicalNames[name] = replacement
  }

  suggestName(
    defaultOrBatch /* 导出的标识符，如 “*” “default” */,
    suggestion /* 建议的 identifier name */
  ) {
    // deconflict anonymous default exports with this module's definitions
    const shouldDeconflict =
      this.exports.default && this.exports.default.isAnonymous
    // suggestion: 如 default，合 当前模块的定义，如果有重复，则在前面添加一个 _ 直到和当前模块的变量没有重名为止，如 `___default`
    if (shouldDeconflict) suggestion = deconflict(suggestion, this.definitions)

    if (!this.suggestedNames[defaultOrBatch]) {
      this.suggestedNames[defaultOrBatch] = makeLegalIdentifier(suggestion)
    }
  }
}
