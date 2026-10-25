/** Trusted reporter: test stdout is data, never a test outcome. */
export default async function* reporter(events) {
  for await (const { type, data } of events) {
    if (type === 'test:pass' || type === 'test:fail') {
      const error = data.details?.error
      yield JSON.stringify({ type, name: data.name, skip: Boolean(data.skip), todo: Boolean(data.todo),
        container: data.details?.type === 'suite' || error?.failureType === 'subtestsFailed',
        code: error?.cause?.code ?? error?.code ?? null,
        failureType: error?.failureType ?? null,
        message: error?.cause?.message ?? error?.message ?? null }) + '\n'
    } else if (['test:stdout', 'test:stderr', 'test:diagnostic'].includes(type)) {
      yield JSON.stringify({ type, message: data.message }) + '\n'
    }
  }
}
