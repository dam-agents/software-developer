// Every command of this definition, by the name `bin/sd` takes. A kit adds
// its own beside the factory's: the factory's are the same in every kit, a
// kit's are its own (app/README.md → Porting a kit).

import { audit } from "./developer/audit.ts";
import { workBackup } from "./developer/backup.ts";
import { controlRoom, controlRoomPage } from "./developer/control-room.ts";
import { enforceFinish, install, repoAllowed, sessionLink } from "./developer/harness.ts";
import { precheck } from "./developer/precheck.ts";
import { runState } from "./developer/run-state.ts";
import { verify } from "./developer/verify.ts";
import type { Command } from "./factory/context.ts";
import { validateDefinition } from "./factory/validate.ts";

export const commands: Readonly<Record<string, Command>> = {
  // the factory's
  "validate-definition": validateDefinition,
  // this kit's
  "run-state": runState,
  precheck,
  verify,
  audit,
  "work-backup": workBackup,
  "session-link": sessionLink,
  "repo-allowed": repoAllowed,
  "hook-stop": enforceFinish,
  install,
  "control-room": controlRoom,
  "control-room-page": controlRoomPage,
};
