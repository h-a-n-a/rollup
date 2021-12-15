export default function foo() {
  return embiggen(6, 7)
}

/**
 * Embiggens a number
 * @param {number} num - the number to embiggen
 * @param {number} factor - the factor to embiggen it by
 * @returns {number}
 */
export function embiggen(num, factor) {
  return num * factor
}
