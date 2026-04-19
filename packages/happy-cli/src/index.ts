#!/usr/bin/env node

import chalk from 'chalk'
import { logger } from './ui/logger'
import { handleServeCommand } from './commands/serve'

;(async () => {
  const args = process.argv.slice(2)
  logger.debug('Starting happy CLI with args: ', process.argv)

  const subcommand = args[0]

  if (subcommand === 'serve') {
    try {
      await handleServeCommand(args.slice(1))
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) console.error(error)
      process.exit(1)
    }
    return
  }

  if (subcommand) {
    console.error(chalk.red(`Unknown command: ${subcommand}`))
  }
  console.log(chalk.bold('Usage: ') + 'happy serve [args…]')
  process.exit(subcommand ? 1 : 0)
})()
