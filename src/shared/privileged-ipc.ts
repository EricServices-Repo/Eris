/** Versioned transport for privileged calls. Public IdeApi methods retain their signatures. */
export const privilegedChannel = (channel: string): boolean =>
  /^(?:checkpoint:|git:|models:)/.test(channel) || channel === 'fs:write'
