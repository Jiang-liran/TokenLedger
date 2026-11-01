/// <reference types="vite/client" />

import type { TokenLedgerApi } from '../shared/ipc';

declare global {
  interface Window {
    tokenledger: TokenLedgerApi;
  }
}

export {};
