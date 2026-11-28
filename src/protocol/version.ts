/*
 * The protocol's version, in a module of its own with no imports, so the
 * client can say hello without loading the schemas (and Effect with them).
 */

/**
 * Bumped whenever a schema in src/protocol changes incompatibly, or gains a
 * call an older daemon would not know (2: `thread.modes`), so a client asks
 * an older idle daemon to make way.
 */
export const PROTOCOL_VERSION = 2;
