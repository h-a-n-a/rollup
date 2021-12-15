import { blank } from '../utils/object'

const blockDeclarations = {
  const: true,
  let: true,
}

export default class Scope {
  constructor(options) {
    options = options || {}
    // 如果是当前模块的全局作用域，则不需要父级作用域。这里的 parent 指针可以被用作访问父级作用域链（是一个链表）
    this.parent = options.parent
    this.depth = this.parent ? this.parent.depth + 1 : 0 // 作用域深度，目前不知道是做什么的
    this.declarations = blank() // 作用域中的定义 { [变量名: string]: DeclarationNode }
    this.isBlockScope = !!options.block // 是否为真正的块级作用域（非 function 创建出来的作用域），同时也表示了是否允许将变量声明到上层作用域，如:
    /**
     * if(true) {
     *    class Foo {}
     * }
     *
     *
     * 此时有两层作用域，第一层是全局（TODO: 这个说法准确吗？）作用域（实例化时候定义的），第二层是 block statement 的作用域，
     * 由于 block statement 的上层不是 function，因此 add declaration 时会被提升到 if statement 作用域中。
     *
     * function foo() {
     *    class Bar() {}
     * }
     *
     * 此时有两层作用域，第一层是全局（TODO: 这个说法准确吗？）作用域（实例化时候定义的）。
     *    补充：原本这两层之前还有一个 block statement 的作用域，但由于扫描到 function 以后直接初始化了一个内部作用域，所以这步就省略了，
     *         因此 Scope 中 isBlockScope 的目的是为了判断这个 scope 是由一般的 scope （如 catch block / if block）创建的，还是由 function 创建的
     * 第二层是 function 内部 的作用域（analyse 的时候定义的），由于检测到是 function 创建出来的作用域，因此 Bar 不能被提升至 parent（第一层作用域），因此 class Bar 在 function 内部定义
     */

    // 如果是函数声明，则会有 params 参数，那么就在这个函数作用域中声明  **所有** 变量，可以参考之前的活动对象（active object）
    if (options.params) {
      options.params.forEach((param) => {
        this.declarations[param.name] = param
      })
    }
  }

  // add ( name, isBlockDeclaration ) {
  // 	if ( !isBlockDeclaration && this.isBlockScope ) {
  // 		// it's a `var` or function declaration, and this
  // 		// is a block scope, so we need to go up
  // 		this.parent.add( name, isBlockDeclaration );
  // 	} else {
  // 		this.names.push( name );
  // 	}
  // }
  // 变量名，Acorn 的 declaration Node，这里的目的是声明变量，确定将变量声明在哪、是否需要变量提升
  addDeclaration(name, declaration) {
    // 声明的类型 ClassDeclaration, FunctionDeclaration, VariableDeclaration, FunctionExpression（这个也算，因为等号右边的函数也算声明）

    // 是否为 let / const 声明（使用 let和 const 声明的变量是有块级作用域的）
    // 参考：https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Statements/block
    const isBlockDeclaration =
      declaration.type === 'VariableDeclaration' &&
      blockDeclarations[declaration.kind] // 如果是 let / const 则创建块级作用作用域内不能被重复定义多次）

    if (
      !isBlockDeclaration /* 除了 let / const 的其他任何定义 */ &&
      this.isBlockScope /* 目前看起来只有非 function 定义此值才为 true */
    ) {
      // 如果是 var 或 函数定义则执行变量提升（根据 ECMA 规范）
      // it's a `var` or function declaration, and this
      // is a block scope, so we need to go up
      this.parent.addDeclaration(name, declaration)
    } else {
      // 否则直接在当前作用域内部声明 key: 变量名, value: 所对应的声明节点
      // 例如 let / const 这样的声明就应该声明在当前作用域内部，而不是在父级作用域中（由于没有了变量提升）
      this.declarations[name] = declaration
    }
  }

  contains(name) {
    return !!this.getDeclaration(name)
  }

  // 从同级开始向上查找，直到找到一个包含 name 的作用域，返回该作用域，找不到则返回 null
  findDefiningScope(name) {
    if (!!this.declarations[name]) {
      return this
    }

    if (this.parent) {
      return this.parent.findDefiningScope(name)
    }

    return null
  }

  getDeclaration(name) {
    return (
      this.declarations[name] ||
      (this.parent && this.parent.getDeclaration(name))
    )
  }
}
