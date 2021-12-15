export default function analyse(magicString, module) {
  // first we need to generate comprehensive scope info
  let previousStatement = null
  let commentIndex = 0

  module.statements.forEach((statement) => {
    const node = statement.node

    let trailing = !!previousStatement
    let previousComment

    // TODO surely this can be neater
    // attach leading comment
    do {
      // 还记得分析 ast 的时候 entry comments 就要拿出来么，现在就派上用场了哦！这里将 comment 归属于不同的 statement
      let comment = module.comments[commentIndex]

      // prevent comments inside the previous statement being
      // appended to it
      if (previousStatement) {
        while (comment && comment.start < previousStatement.node.end) {
          commentIndex += 1
          comment = module.comments[commentIndex]
        }
      }

      if (!comment || comment.end > node.start) break

      // attach any trailing comment to the previous statement 有前一个节点，且 comment 和 statement 没有换行时则为 trailing comment，如： var a = "1" // this is a trailing comment
      if (
        trailing &&
        !/\n/.test(
          module.source.slice(previousStatement.node.end, comment.start)
        )
      ) {
        previousStatement.trailingComment = comment
      }

      // then attach leading comments to this statement，statement 前面的 comment 都是 leading comment
      else {
        statement.leadingComments.push({
          separator: previousComment
            ? magicString.slice(previousComment.end, comment.start)
            : '\n',
          comment,
        })

        previousComment = comment
      }

      commentIndex += 1
      trailing = false
    } while (module.comments[commentIndex])

    // determine margin
    const previousEnd = previousComment
      ? previousComment.end
      : previousStatement
      ? (previousStatement.trailingComment || previousStatement.node).end
      : 0

    //const start = ( statement.leadingComments[0] || node ).start;
    // previousEnd，上一个节点的 end
    const gap = magicString.original.slice(previousEnd, node.start)
    const margin = gap.split('\n').length // 记录和前一个 statement 换了多少行
    // [和前一个statement的 margin, 和后一个statement的 margin]
    if (previousStatement) previousStatement.margin[1] = margin
    statement.margin[0] = margin

    // 分析 statement 的作用域
    statement.analyse()

    previousStatement = statement
  })
}
