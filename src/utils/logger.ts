import chalk from 'chalk';
import type { Logger } from '../types/index.js';

export function createLogger(verbose = false): Logger {
  return {
    info(msg: string): void {
      console.log(chalk.cyan('  [INFO] ') + msg);
    },
    warn(msg: string): void {
      console.warn(chalk.yellow('  [WARN] ') + msg);
    },
    error(msg: string): void {
      console.error(chalk.red('  [ERR]  ') + msg);
    },
    debug(msg: string): void {
      if (verbose) {
        console.log(chalk.gray(' [DEBUG] ') + msg);
      }
    },
    success(msg: string): void {
      console.log(chalk.green('    [OK] ') + msg);
    },
    phase(name: string, msg: string): void {
      console.log(chalk.bold.magenta(`\n  [${name}] `) + chalk.white(msg));
    },
  };
}
