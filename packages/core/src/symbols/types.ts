export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'method'
  | 'property'
  | 'module';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  /** 1-based start line */
  line: number;
  /** 1-based end line (inclusive) */
  endLine?: number;
  /** Parent name, e.g. class name for methods */
  containerName?: string;
}

export interface FileSymbols {
  path: string;
  symbols: SymbolInfo[];
  /** File modification time for cache invalidation */
  mtime: number;
}
