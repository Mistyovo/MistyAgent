import { Command } from 'commander';

const program = new Command();

program
  .name('misty')
  .description('A personal CLI coding agent')
  .version('0.1.0');

program.parse();
