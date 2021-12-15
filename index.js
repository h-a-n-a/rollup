const rollup = require('./src/rollup')

;(async () => {
  const bundle = await rollup.rollup({
    entry: './test/form/block-comments/main.js',
    // entry: './test/form/internal-conflict-resolution/foo.js',
  })

  const result = bundle.generate({
    format: 'cjs',
    sourceMap: true,
  })

  console.log(result.code)
})()
