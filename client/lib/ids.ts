export function randomId(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

