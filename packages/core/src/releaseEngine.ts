import { z } from 'zod';

/** The engine build a published app pins: the served file, its sha512 integrity string and the package version. */
export const releaseEngineSchema = z.object({
  name: z.literal('tentkit'),
  file: z.string().min(1),
  integrity: z.string().min(1),
  version: z.string().min(1),
}).strict();
export type ReleaseEngine = z.infer<typeof releaseEngineSchema>;
