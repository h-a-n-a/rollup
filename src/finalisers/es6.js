import { keys } from '../utils/object'

export default function es6(bundle, magicString, { exportMode }, options) {
  const introBlock = '' // TODO...

  const exports = bundle.entryModule.exports
  const exportBlock = keys(exports)
    .map(
      (
        exportedName /* default / ... (export { a, b, c } 将会被拆成多个语句)  */
      ) => {
        const specifier = exports[exportedName]

        const canonicalName = bundle.entryModule.getCanonicalName(
          specifier.localName
        )

        if (exportedName === 'default') {
          return `export default ${canonicalName};`
        }

        return exportedName === canonicalName
          ? `export { ${exportedName} };`
          : `export { ${canonicalName} as ${exportedName} };`
      }
    )
    .join('\n')

  if (exportBlock) {
    magicString.append('\n\n' + exportBlock)
  }

  return magicString.trim()
}
