export type AuthMode = 'local' | 'multi';

export function resolveAuthMode(value: string | undefined): AuthMode {
  const mode = value?.toLowerCase();
  return mode === 'multi' ? 'multi' : 'local';
}

export function getAuthMode(): AuthMode {
  return resolveAuthMode(process.env.AUTH_MODE);
}
