// Disjoint ridge regression. Cholesky solves avoid explicit matrix inversion.
export function scoreContext(x, observations, { alpha, lambda }) {
  const n = x.length
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? lambda : 0))
  const b = Array(n).fill(0)
  for (const { context, reward } of observations) {
    for (let i = 0; i < n; i++) {
      b[i] += reward * context[i]
      for (let j = 0; j < n; j++) A[i][j] += context[i] * context[j]
    }
  }
  const L = Array.from({ length: n }, () => Array(n).fill(0))
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let sum = A[i][j]
    for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k]
    if (i === j && !(sum > 0)) throw new Error('LinUCB matrix is not positive definite')
    L[i][j] = i === j ? Math.sqrt(sum) : sum / L[j][j]
  }
  const solve = v => {
    const y = Array(n).fill(0), z = Array(n).fill(0)
    for (let i = 0; i < n; i++) {
      let sum = v[i]
      for (let j = 0; j < i; j++) sum -= L[i][j] * y[j]
      y[i] = sum / L[i][i]
    }
    for (let i = n - 1; i >= 0; i--) {
      let sum = y[i]
      for (let j = i + 1; j < n; j++) sum -= L[j][i] * z[j]
      z[i] = sum / L[i][i]
    }
    return z
  }
  const dot = (a, v) => a.reduce((sum, value, i) => sum + value * v[i], 0)
  const mean = dot(x, solve(b)), variance = dot(x, solve(x))
  const bonus = alpha * Math.sqrt(Math.max(0, variance))
  if (![mean, variance, bonus, mean + bonus].every(Number.isFinite)) throw new Error('Non-finite LinUCB score')
  return { mean, bonus, score: mean + bonus, samples: observations.length }
}
