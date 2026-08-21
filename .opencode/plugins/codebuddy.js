/**
 * CodeBuddy plugin for OpenCode — re-export server plugin for .opencode discovery
 * OpenCode loads .opencode/plugins/*.js as plugins; this wrapper ensures
 * both file:// and npm git+https installs are discovered without manual file:// path.
 */
export { CodeBuddyAuthPlugin as CodebuddyPlugin } from "../../dist/index.js";
export { default } from "../../dist/index.js";
