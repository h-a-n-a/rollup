import { blank, keys } from './utils/object'
import { sequence } from './utils/promise'
import getLocation from './utils/getLocation'
import walk from './ast/walk'
import Scope from './ast/Scope'

/**
 (function  () {
    
  })()

{
      "type": "ExpressionStatement",
      "start": 226,
      "end": 249,
      "expression": {
        "type": "CallExpression",
        "start": 226,
        "end": 249,
        "callee": {
          "type": "FunctionExpression",
          "start": 227,
          "end": 246,
          "id": null,
          "expression": false,
          "generator": false,
          "async": false,
          "params": [],
          "body": {
            "type": "BlockStatement",
            "start": 240,
            "end": 246,
            "body": []
          }
        },
        "arguments": [],
        "optional": false
      }
    },

 */

function isIife(node, parent) {
  return parent && parent.type === 'CallExpression' && node === parent.callee
}

export default class Statement {
  constructor(node, magicString, module, index) {
    // statement 所属 acorn 节点，例如 var 节点：{type: 'VariableDeclaration', kind: 'var', start: 0, end: 18, declarations: Array(1)}
    this.node = node
    // 当前  statement 所属模块
    this.module = module
    // 对应 statement 的 magicString（原字符串依旧是整个模块） 一样是为了修改字符串 + 获取到 sourcemap
    this.magicString = magicString
    // 当前 statement 在模块 statements 数组中的索引（记录原始的数据）
    this.index = index
    // 模块路径加上述索引，可以快速获取到当前 statement
    this.id = module.id + '#' + index

    // 创建 statement 对应作用域，第一层作用域定义的变量又称之为当前模块 topLevelNames
    this.scope = new Scope()

    // Statement中定义的 topLevel 变量，Record<IdentifierName, boolean>
    this.defines = blank()
    // 修改过的变量（这个变量可能不是来自于这个Statement） Record<IdentifierName, boolean>， eg: a = 1, a++, foo(a)，则 { "a": true }
    this.modifies = blank()

    // dependsOn / stronglyDependsOn 内部会包含 modifies，从语义上来看 modifies 也是依赖的一部分
    // statement 的依赖变量（可能是外部同样可能是内部依赖） Record<NodeName, boolean>，非 stronglyDependsOn 的依赖
    this.dependsOn = blank()
    // 强引用的外部依赖 当引用的变量的路径上没有被 非 iife 的 function 包裹过，那么就是强依赖，TODO: 记录强引用的作用是什么呢？
    this.stronglyDependsOn = blank()

    this.isIncluded = false
    // 具体看：src/ast/analyse.js 的注释
    this.leadingComments = []
    this.trailingComment = null
    this.margin = [0, 0] // [和前一个statement的 margin, 和后一个statement的 margin]（margin = 换了多少行）

    // some facts about this statement...
    this.isImportDeclaration = node.type === 'ImportDeclaration'
    this.isExportDeclaration = /^Export/.test(node.type) // ExportNamedDeclaration or ExportDefaultDeclaration
  }
  // 根据 statement 的类型创建看是否需要创建作用域（只创建当前一层），并将变量声明绑定到对应作用域上（这是初始化一个 Module 的最后一步）
  analyse() {
    if (this.isImportDeclaration) return // nothing to analyse

    const statement = this // TODO use arrow functions instead
    const magicString = this.magicString

    let scope = this.scope
    // 递归遍历所有子节点，以及所有为对象的子节点（不管该节点是不是 Node 类型）
    // 什么时候创建新作用域？目前看 function / 父级非 function 的 block statement（例如 if 语句）/ catch(e) {}
    walk(this.node, {
      enter(node, parent) {
        let newScope

        magicString.addSourcemapLocation(node.start)

        switch (node.type) {
          case 'FunctionExpression': // const foo = function () {...}
          case 'FunctionDeclaration': // function foo() {}
          case 'ArrowFunctionExpression': // const foo = () => {}
            if (node.type === 'FunctionDeclaration') {
              // 在当前作用域中定义
              scope.addDeclaration(node.id.name, node)
            }
            // 创建函数内部的作用域
            newScope = new Scope({
              parent: scope,
              params: node.params, // TODO rest params? // 添加函数签名参数
              block: false, // 函数内部不重复创建 block statement
            })
            // 函数表达式的函数名算作函数作用域内的变量，因为只能在函数内部访问到所以定义在 newScope，如 const a = function b() {}，b 就是函数表达式的函数名
            // 而函数表达式的变量名则是外部变量，由下方 VariableDeclaration 定义到当前作用域 ，如 const a = function b() {}，中的 a 变量
            // named function expressions - the name is considered
            // part of the function's scope
            if (node.type === 'FunctionExpression' && node.id) {
              newScope.addDeclaration(node.id.name, node)
            }
            // 箭头函数的名字不作为新/老作用域中的变量
            break

          case 'BlockStatement': // if语句： if() **{}** / 函数声明： function a() **{}** / 单独： **{}** / 等等（星星内部的是 block statement 通常用 {} 表示）
            // blockStatement 通常依赖 parent 一起定义，但遇到父级是 function 的情况则服用 function 的作用域
            if (!/Function/.test(parent.type)) {
              newScope = new Scope({
                parent: scope,
                block: true,
              })
            }

            break

          case 'CatchClause': // catch(e) **{}**
            newScope = new Scope({
              parent: scope,
              params: [node.param],
              block: true,
            })

            break

          case 'VariableDeclaration':
            node.declarations.forEach((declarator) => {
              // var / let / const 都可以一条语句同时声明多个变量，添加到当前作用域
              scope.addDeclaration(declarator.id.name, node)
            })
            break

          case 'ClassDeclaration':
            scope.addDeclaration(node.id.name, node) // class 的名称可以被外部访问到，所以添加到当前作用域
            break
        }

        if (newScope) {
          // 创建新作用域后绑定到当前 declaration node 上，然后将新创建的 newScope 作为 scope，以便生成作用域
          Object.defineProperty(node, '_scope', { value: newScope })
          scope = newScope
        }
      },
      leave(node) {
        // 还原 scope 指针
        if (node._scope) {
          scope = scope.parent
        }
      },
    })
    // TODO: 区分强弱引用的作用是什么？
    // This allows us to track whether we're looking at code that will
    // be executed immediately (either outside a function, or immediately
    // inside an IIFE), for the purposes of determining whether dependencies
    // are strong or weak. It's not bulletproof, since it wouldn't catch...
    //
    //    var calledImmediately = function () {
    //      doSomethingWith( strongDependency );
    //    }
    //    calledImmediately(); // outside a function
    //
    // ...but it's better than nothing

    // 记录非 iife 的 function 的嵌套层级
    // 这里的 depth 和 scope.depth 是有区别的
    // depth: 只有当 node 为 function 且不是 iife 时深度 + 1，其他情况不变
    // scope.depth: 只要创建了 scope 且有父级 scope 则深度就 + 1
    let depth = 0
    // 递归遍历，做读写检查，为后续拉取其他模块做准备
    if (!this.isImportDeclaration) {
      walk(this.node, {
        enter: (node, parent) => {
          // 获取当前节点的作用域，_scope 表示当前节点内部的作用域（作用域可以是块级也可以不是块级，rollup 中把 function），例如 function foo() {} 则 _scope 就表示为 foo 内部的作用域
          if (node._scope) {
            // 当这个节点是 function 且这个 function 不是 iife 的时候深度才会 + 1，其他情况下深度不变
            if (!scope.isBlockScope && !isIife(node, parent)) depth += 1
            // 切换为内部的作用域
            scope = node._scope
          }

          this.checkForReads(
            scope /* 距离这个 node 最近的 scope */,
            node,
            parent,
            !depth
          )
          this.checkForWrites(scope /* 距离这个 node 最近的 scope */, node)
        },
        leave: (node, parent) => {
          if (node._scope) {
            if (!scope.isBlockScope && !isIife(node, parent)) depth -= 1
            // 回溯到上层作用域
            scope = scope.parent
          }
        },
      })
    }

    // 把第一层作用域(TopLevel)的变量都定义到 statement 的 defines 中
    keys(scope.declarations).forEach((name) => {
      statement.defines[name] = true
    })
  }

  // 找到当前节点依赖的变量，并将其加入到依赖列表(dependsOn stronglyDependsOn)中
  // 当前节点作用域 当前节点 父节点 是否为 strong dep（深度为 0）TODO: 区分 strong 与 weak 的作用是？
  // Strong: 当前作用域还没有被 非 iife 的 function 包裹过
  // Weak: 当前作用域被 非 iife 的 function 包裹过了，例如 function foo() { /* 这里的 depth 已经是 1 */ }; if(true) { /* 这里的 depth 是 */ }，此处的 depth 非 scope.depth
  checkForReads(scope, node, parent, strong) {
    if (node.type === 'Identifier') {
      // 注意，接下来会有一些 Identifier 会被跳过，跳过的 Identifier 均是上方 analyse 部分未被收集到的，并且不需要收集 TODO: 跳过的目的应该是因为不用做这么细粒度的 tree-shaking ？

      /**
       * code:
       *  c.a
       * 
       * AST:
       * {
                "type": "ExpressionStatement",
                "start": 120,
                "end": 123,
                "expression": {
                  "type": "MemberExpression",
                  "start": 120,
                  "end": 123,
                  "object": { // 访问的对象，如果是 c.a.b 的嵌套结构，这里的 object 类型是 c.a 的 MemberExpression，最外层的 property 则是 b（外层永远是最后一个"." 后的 property）
                    "type": "Identifier",
                    "start": 120,
                    "end": 121,
                    "name": "c"
                  },
                  "property": { // 访问的 property
                    "type": "Identifier",
                    "start": 122,
                    "end": 123,
                    "name": "a"
                  },
                  "computed": false,
                  "optional": false
                }
              }
       */
      // 对于 MemberExpression 只记录 object 的访问，跳过记录 property 的访问（没毛病，tree-shaking 不做 property 的）
      // disregard the `bar` in `foo.bar` - these appear as Identifier nodes
      if (parent.type === 'MemberExpression' && node !== parent.object) {
        return
      }

      /**
       * Code:
       * {
       *   bar: foo
       * }
       * 
       * AST:
       * {
            "type": "ObjectExpression",
            "start": 95,
            "end": 109,
            "properties": [
              {
                "type": "Property",
                "start": 99,
                "end": 107,
                "method": false,
                "shorthand": false,
                "computed": false,
                "key": {
                  "type": "Identifier",
                  "start": 99,
                  "end": 102,
                  "name": "bar"
                },
                "value": {
                  "type": "Identifier",
                  "start": 104,
                  "end": 107,
                  "name": "foo"
                },
                "kind": "init"
              }
            ]
          }
       */
      // 对于 Property 的定义，只记录 value 的访问，跳过 key
      // disregard the `bar` in { bar: foo }
      if (parent.type === 'Property' && node !== parent.value) {
        return
      }

      // 跳过 MethodDefinition 的记录
      // disregard the `bar` in `class Foo { bar () {...} }`
      if (parent.type === 'MethodDefinition') return

      // 所有 identifier 都有 name，因此这里是安全的
      // 向上查找当前 statement 的作用域，直到找到一个包含改 name 的作用域，找不到则返回 null
      const definingScope = scope.findDefiningScope(node.name)

      // 将首层作用域/runtime 全局作用域的变量加入到 statement 中的 dependsOn 中
      // 添加首层作用域的意义是为了让该名字在未来 naming deconflict 的时候不被修改？TODO:
      if (
        // 如果没有找到对应名称所在的作用域(其他 statement 中的定义，或只是 runtime 给的变量)
        // 或是 identifier name 所在的作用域深度为 0（注意：这里的深度是 scope.depth，表示 node.name 为这个 statement 的最外层的声明，例如 function foo() {} 的 foo）
        (!definingScope || definingScope.depth === 0) &&
        // 跑这里的时候 defines 还没有生成完毕，因此 dependsOn 不一定全是外部依赖
        !this.defines[node.name]
      ) {
        this.dependsOn[node.name] = true
        if (strong) this.stronglyDependsOn[node.name] = true
      }
    }
  }

  // 检查被写入的节点是否可以被写入（如写入 import 的情况）
  checkForWrites(scope, node) {
    const addNode = (node, isAssignment) => {
      let depth = 0 // determine whether we're illegally modifying a binding or namespace

      // 找到最深处的 Identifier，如 c.a.b.e，则返回 c
      // c.a 的深度为 1，c.a.b 的深度为 2
      while (node.type === 'MemberExpression') {
        node = node.object
        depth += 1
      }

      // disallow assignments/updates to imported bindings and namespaces
      if (isAssignment) {
        // 找到 statement 对应模块的 import 节点
        const importSpecifier = this.module.imports[node.name]

        // 当 importSpecifier 里有这个节点，且当前 node 最近的作用域不存在 node.name
        if (importSpecifier && !scope.contains(node.name)) {
          const minDepth =
            importSpecifier.name === '*'
              ? 2 // cannot do e.g. `namespace.foo = bar`，但可以 `namespace.foo.xxx = bar`（当 foo 是 object），此时深度为 2，最小允许编辑的深度为 2
              : 1 // cannot do e.g. `foo = bar`, but `foo.bar = bar` is fine，最小允许编辑的深度为 1

          if (depth < minDepth) {
            const err = new Error(
              `Illegal reassignment to import '${node.name}'`
            )
            err.file = this.module.id
            err.loc = getLocation(
              this.module.magicString.toString(),
              node.start
            )
            throw err
          }
        }

        // special case = `export default foo; foo += 1;` - we'll
        // need to assign a new variable so that the exported
        // value is not updated by the second statement
        if (
          this.module.exports.default &&
          depth === 0 &&
          this.module.exports.default.identifier === node.name
        ) {
          // but only if this is a) inside a function body or
          // b) after the export declaration
          if (
            !!scope.parent ||
            node.start > this.module.exports.default.statement.node.start
          ) {
            this.module.exports.default.isModified = true
          }
        }
      }

      if (node.type === 'Identifier') {
        this.modifies[node.name] = true
      }
    }

    // 记录左侧被写入的节点
    if (node.type === 'AssignmentExpression') {
      /**
     * Code:
     * a = 1
     * 
     * AST:
     * {
        "type": "ExpressionStatement",
        "start": 149,
        "end": 155,
        "expression": {
          "type": "AssignmentExpression",
          "start": 149,
          "end": 154,
          "operator": "=",
          "left": { // 记录这个节点
            "type": "Identifier",
            "start": 149,
            "end": 150,
            "name": "a"
          },
          "right": {
            "type": "Literal",
            "start": 153,
            "end": 154,
            "value": 1,
            "raw": "1"
          }
        }
      },
     */
      addNode(node.left, true)
    } else if (node.type === 'UpdateExpression') {
      // 记录 a++, a--, --a, ++a 的节点
      /**
       * Code:
       * a++
       * 
       * AST:
       * {
          "type": "ExpressionStatement",
          "start": 144,
          "end": 147,
          "expression": {
            "type": "UpdateExpression",
            "start": 144,
            "end": 147,
            "operator": "++",
            "prefix": false,
            "argument": { // 记录这个被写入的节点
              "type": "Identifier",
              "start": 144,
              "end": 145,
              "name": "a"
            }
          }
        },
       */
      addNode(node.argument, true)
    } else if (node.type === 'CallExpression') {
      /**
       * Code:
       * foo(1,a)
       * 
       * 
       * {
          "type": "CallExpression",
          "start": 108,
          "end": 112,
          "callee": {
            "type": "Identifier",
            "start": 108,
            "end": 109,
            "name": "foo"
          },
          "arguments": [ // 记录这个列表
            {
              "type": "Literal", // 这个其实不会被记录下来，具体看 addNode 的实现
              "start": 110,
              "end": 111,
              "value": 1,
              "raw": "1"
            },
            {
              "type": "Identifier", // 会被标记为 modifies，TODO: 这里是为了跟踪副作用吗？
              "start": 112,
              "end": 113,
              "name": "a"
            }
          ],
          "optional": false
        }
       */
      node.arguments.forEach((arg) => addNode(arg, false))

      // `foo.bar()` is assumed to mutate foo
      if (node.callee.type === 'MemberExpression') {
        addNode(node.callee)
      }
    }
  }

  // module markAllStatement 调用
  // 标记（引入） statement 所有依赖
  mark() {
    // mark 过了就不用再调用了
    // TODO: 确认一下，这里看起来是写错了？应该是 isIncluded，然后为什么这里不返回一个 `Promise.resolve()`？
    // 这里之所以不会报错，是因为在 Module.mark() 中，会先判断是否已经 mark 过了，如果已经 mark 过了(definitionPromises)，就不会再调用 statement.mark() 了
    if (this.included) return // prevent infinite loops
    this.isIncluded = true

    const dependencies = Object.keys(this.dependsOn)

    return sequence(dependencies, (name) => {
      // 这句话看起来没有作用了，在 checkForReads 内部已经先判断 this.defines[node.name] 再确定是否添加进 dependsOn 了
      if (this.defines[name]) return // TODO maybe exclude from `this.dependsOn` in the first place?
      // 在 module 中标记当前 statements 依赖的变量
      return this.module.mark(name)
    })
  }

  /**
   * 将模块内部的变量与 canonicalName 或导出语句对齐
   * @param {Record<LocalName, CanonicalName>} names 用于替换的变量
   * @param {*} bundleExports TODO:
   * @returns
   */
  replaceIdentifiers(names, bundleExports) {
    const magicString = this.magicString.clone()
    const replacementStack = [names]
    const nameList = keys(names)

    let deshadowList = []
    nameList.forEach((name) => {
      // 替换的语句
      const replacement = names[name]
      deshadowList.push(replacement.split('.')[0]) // 如果是 exports.foo 则拿到 exports，否则拿到对应 canonicalName
    })

    let topLevel = true
    // 这里的 depth 指是否在 function 内部，用于 this 的计算，与之前的 depth 不同
    let depth = 0

    walk(this.node, {
      enter(node, parent) {
        // 是否跳过，在下方定义了，TODO:
        if (node._skip) return this.skip()

        if (/^Function/.test(node.type)) depth += 1

        // `this` is undefined at the top level of ES6 modules
        if (node.type === 'ThisExpression' && depth === 0) {
          magicString.overwrite(node.start, node.end, 'undefined')
        }

        // special case - variable declarations that need to be rewritten
        // as bundle exports
        if (topLevel) {
          if (node.type === 'VariableDeclaration') {
            // if this contains a single declarator, and it's one that
            // needs to be rewritten, we replace the whole lot
            const name = node.declarations[0].id.name
            if (node.declarations.length === 1 && bundleExports[name]) {
              magicString.overwrite(
                node.start,
                node.declarations[0].id.end,
                bundleExports[name]
              )
              node.declarations[0].id._skip = true
            }

            // otherwise, we insert the `exports.foo = foo` after the declaration
            else {
              const exportInitialisers = node.declarations
                .map((declarator) => declarator.id.name)
                .filter((name) => !!bundleExports[name])
                .map((name) => `\n${bundleExports[name]} = ${name};`)
                .join('')

              // TODO clean this up
              try {
                magicString.insert(node.end, exportInitialisers)
              } catch (err) {
                magicString.append(exportInitialisers)
              }
            }
          }
        }

        const scope = node._scope

        if (scope) {
          topLevel = false

          // 当前 scope 的新变量
          let newNames = blank()
          // 当前作用域是否有替换，下方会创建一个 stack 专门维护这个 newNames 的变化，如果平级就可以直接复用这个 newNames 列表进行替换了
          let hasReplacements

          // special case = function foo ( foo ) {...}
          if (
            node.id &&
            names[node.id.name] &&
            scope.declarations[node.id.name]
          ) {
            magicString.overwrite(
              node.id.start,
              node.id.end,
              names[node.id.name]
            )
          }

          keys(names).forEach((name) => {
            // 当前 scope 没有定义这个变量，但 name list 里却有，则对于当前的 scope 为外部的新变量，添加到 newNames 中，以便后续替换
            // 如果当前 scope 定义了这个变量，那就没必要替换了，新的定义会把旧的覆盖掉
            if (!scope.declarations[name]) {
              newNames[name] = names[name]
              hasReplacements = true // 标记可能（但不一定）会有替换
            }
          })

          deshadowList.forEach((name) => {
            if (~scope.declarations[name]) {
              // TODO is this right? no indexOf?
              newNames[name] = name + '$$' // TODO better mechanism
              hasReplacements = true
            }
          })

          if (!hasReplacements && depth > 0) {
            // 非首层作用域内并且没有可能的替换，则跳过
            return this.skip()
          }

          names = newNames
          replacementStack.push(newNames)
        }

        // We want to rewrite identifiers (that aren't property names etc)
        if (node.type !== 'Identifier') return
        if (
          parent.type === 'MemberExpression' &&
          !parent.computed &&
          node !== parent.object
        )
          return
        if (parent.type === 'Property' && node !== parent.value) return
        // TODO others...?

        // 拿到当前 node.name 的替换，也可能没有
        const name = names[node.name]

        // 如果有要替换的，则替换
        if (name && name !== node.name) {
          magicString.overwrite(node.start, node.end, name)
        }
      },

      leave(node) {
        if (/^Function/.test(node.type)) depth -= 1

        if (node._scope) {
          replacementStack.pop()
          names = replacementStack[replacementStack.length - 1]
        }
      },
    })

    return magicString
  }
}
