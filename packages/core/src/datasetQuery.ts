import { z } from 'zod';

// The one typed dataset-query grammar; values are always parameterized and no raw-SQL arm exists.

export const datasetWhereSchema = z.object({
  col: z.string().min(1).max(64),
  op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains']),
  value: z.union([z.string(), z.number(), z.boolean()]),
}).strict();
export type DatasetWhere = z.infer<typeof datasetWhereSchema>;

export const datasetOrderBySchema = z.object({
  col: z.string().min(1).max(64),
  dir: z.enum(['asc', 'desc']).default('asc'),
}).strict();

export const datasetAggregateSchema = z.object({
  groupBy: z.array(z.string().min(1).max(64)).max(4).optional(),
  metrics: z.array(z.object({
    fn: z.enum(['count', 'sum', 'avg', 'min', 'max']),
    col: z.string().min(1).max(64).optional(),
  }).strict().refine((m) => m.fn === 'count' || m.col !== undefined, { message: 'sum/avg/min/max name their column; count may omit it' }))
    .min(1).max(6),
}).strict();

export const datasetQuerySchema = z.object({
  where: z.array(datasetWhereSchema).max(8).optional(),
  orderBy: z.array(datasetOrderBySchema).max(4).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
  aggregate: datasetAggregateSchema.optional(),
}).strict();
export type DatasetQuery = z.infer<typeof datasetQuerySchema>;
