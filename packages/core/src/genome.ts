import { z } from 'zod';

export const genomeCreatorSchema = z.enum(['human', 'forge', 'evolve']);
export type GenomeCreator = z.infer<typeof genomeCreatorSchema>;

const ioFieldSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

export const ioContractSchema = z.object({
  inputs: z.array(ioFieldSchema),
  outputs: z.array(ioFieldSchema).min(1),
});
export type IoContract = z.infer<typeof ioContractSchema>;

export const testCaseSchema = z.object({
  name: z.string().min(1),
  input: z.record(z.unknown()),
  expectation: z.string().min(1),
});
export type GenomeTestCase = z.infer<typeof testCaseSchema>;

export const genomeInputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'kebab-case required'),
  capability: z.string().min(10),
  instructions: z.string().min(20),
  ioContract: ioContractSchema,
  testCases: z.array(testCaseSchema),
  createdBy: genomeCreatorSchema,
  parentVersion: z.number().int().positive().optional(),
  lineageNote: z.string().optional(),
});
export type GenomeInput = z.infer<typeof genomeInputSchema>;
