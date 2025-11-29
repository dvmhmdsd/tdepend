import { TDependConfig } from "../config/schema";

export function log(config: TDependConfig, message: string): void {
  if (config.ci.outputFormat !== 'json') {
    console.log(message);
  }
}
