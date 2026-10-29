import { Module } from '@nestjs/common';

import { FunctionalityModules } from '../app.module';
import { ServerConfigModule } from '../core/config';
import { ChatgptCommand } from './commands/chatgpt';
import { CreateCommand } from './commands/create';
import { CutoverCommand } from './commands/cutover';
import { ImportConfigCommand } from './commands/import';
import { RevertCommand, RunCommand } from './commands/run';

@Module({
  imports: [...FunctionalityModules, ServerConfigModule],
  providers: [
    CreateCommand,
    ChatgptCommand,
    CutoverCommand,
    RunCommand,
    RevertCommand,
    ImportConfigCommand,
  ],
})
export class CliAppModule {}
