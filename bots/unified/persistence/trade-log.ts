import { appendFileSync } from 'fs';
import type { Trade } from '../controllers/types.ts';

export class TradeLog {
  constructor(private readonly filePath: string) {}

  write(trade: Trade): void {
    appendFileSync(this.filePath, JSON.stringify(trade) + '\n');
  }
}
