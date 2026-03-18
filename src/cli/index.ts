#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../config/loader.js';
import { createLogger } from '../utils/logger.js';
import { runPipeline } from '../pipeline/runner.js';
import type { DeobfuscatorConfig } from '../types/index.js';

const BANNER = chalk.bold.cyan(`
  ╔══════════════════════════════════════════╗
  ║    cs-decompile-workflow  v0.1.0         ║
  ║    ILSpy C# De-obfuscation Pipeline      ║
  ╚══════════════════════════════════════════╝
`);

function applyOverrides(
  config: DeobfuscatorConfig,
  opts: { input?: string; output?: string; dryRun?: boolean },
): DeobfuscatorConfig {
  const result = { ...config };
  if (opts.input) result.inputPath = opts.input;
  if (opts.output) result.outputPath = opts.output;
  if (opts.dryRun) result.dryRun = true;
  return result;
}

interface GlobalOptions {
  config?: string;
  input?: string;
  output?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

async function runCommand(phases: string[], opts: GlobalOptions): Promise<void> {
  console.log(BANNER);
  const logger = createLogger(opts.verbose ?? false);

  try {
    const config = await loadConfig(opts.config);
    const finalConfig = applyOverrides(config, {
      input: opts.input,
      output: opts.output,
      dryRun: opts.dryRun,
    });

    logger.info(`Input:  ${finalConfig.inputPath}`);
    logger.info(`Output: ${finalConfig.outputPath}`);
    logger.info(`Phases: ${phases.join(', ')}`);
    if (finalConfig.dryRun) logger.warn('DRY RUN mode - no files will be written');

    const start = Date.now();
    const context = await runPipeline(finalConfig, phases, logger);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(
      chalk.bold.green(`\n  ✓ Pipeline complete in ${elapsed}s`) +
        chalk.gray(` | Files: ${context.projectMeta?.totalFiles ?? 0}`) +
        chalk.gray(` | Clusters: ${Object.keys(context.globalCluster?.clusters ?? {}).length}`),
    );
  } catch (err) {
    console.error(chalk.red(`\n  ✗ Fatal error: ${String(err)}`));
    process.exit(1);
  }
}

const program = new Command();

program
  .name('csdeob')
  .description('Automated repair, de-obfuscation preprocessing and structured analysis for ILSpy-decompiled C# projects')
  .version('0.1.0');

// Global options
program
  .option('-c, --config <path>', 'config file path')
  .option('-i, --input <path>', 'input directory (overrides config)')
  .option('-o, --output <path>', 'output directory (overrides config)')
  .option('--dry-run', 'dry run mode - no files will be written')
  .option('--verbose', 'verbose logging');

program
  .command('scan')
  .description('Run Phase A: project discovery')
  .action(async (_cmdOpts, cmd) => {
    const opts = cmd.parent.opts() as GlobalOptions;
    await runCommand(['A'], opts);
  });

program
  .command('index')
  .description('Run Phases A+B: discovery and indexing')
  .action(async (_cmdOpts, cmd) => {
    const opts = cmd.parent.opts() as GlobalOptions;
    await runCommand(['A', 'B'], opts);
  });

program
  .command('repair')
  .description('Run Phases A+B+C: discovery, indexing, and repair')
  .action(async (_cmdOpts, cmd) => {
    const opts = cmd.parent.opts() as GlobalOptions;
    await runCommand(['A', 'B', 'C'], opts);
  });

program
  .command('cleanup')
  .description('Run Phases A+B+C+D: through aggressive cleanup')
  .action(async (_cmdOpts, cmd) => {
    const opts = cmd.parent.opts() as GlobalOptions;
    await runCommand(['A', 'B', 'C', 'D'], opts);
  });

program
  .command('cluster')
  .description('Run Phases A+B+C+D+E: through global clustering')
  .action(async (_cmdOpts, cmd) => {
    const opts = cmd.parent.opts() as GlobalOptions;
    await runCommand(['A', 'B', 'C', 'D', 'E'], opts);
  });

program
  .command('all')
  .description('Run all phases A through F')
  .action(async (_cmdOpts, cmd) => {
    const opts = cmd.parent.opts() as GlobalOptions;
    await runCommand(['all'], opts);
  });

program
  .command('report')
  .description('Run Phase F only: generate reports from cached data')
  .action(async (_cmdOpts, cmd) => {
    const opts = cmd.parent.opts() as GlobalOptions;
    await runCommand(['F'], opts);
  });

program.parse(process.argv);
