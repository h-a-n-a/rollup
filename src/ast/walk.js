import { blank } from '../utils/object'

let shouldSkip
let shouldAbort

export default function walk(ast, { enter, leave }) {
  shouldAbort = false
  visit(ast, null, enter, leave)
}

let context = {
  skip: () => (shouldSkip = true),
  abort: () => (shouldAbort = true),
}
// key value 的 hashmap，用当前 node type 作为 key，value 为当前 node 以对象为 value 的 key 的数组，例如：{ declaration: [], ... }，declaration 为对象，则存入 childKey
let childKeys = blank()

let toString = Object.prototype.toString

function isArray(thing) {
  return toString.call(thing) === '[object Array]'
}
// visitor AcornNode AcornNode EnterCallback LeaveCallback
function visit(node, parent, enter, leave) {
  if (!node || shouldAbort) return

  if (enter) {
    shouldSkip = false
    enter.call(context, node, parent)
    if (shouldSkip || shouldAbort) return
  }

  let keys =
    childKeys[node.type] ||
    (childKeys[node.type] = Object.keys(node).filter(
      (key) => typeof node[key] === 'object'
    ))

  let key, value, i, j

  i = keys.length
  while (i--) {
    key = keys[i]
    value = node[key]

    if (isArray(value)) {
      j = value.length
      while (j--) {
        visit(value[j], node, enter, leave)
      }
    } else if (value && value.type) {
      visit(value, node, enter, leave)
    }
  }

  if (leave && !shouldAbort) {
    leave(node, parent)
  }
}
