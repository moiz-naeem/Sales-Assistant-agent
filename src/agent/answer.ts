// This file describes the final answer the model must hand in.
// Everything it says has to point at something a tool returned, so each claim carries its evidence ids.

import { z } from "zod";

export const SubmitAnswer = z.strictObject({
  answer: z.string().min(1),
  recommendation: z
    .strictObject({
      product_id: z.string(),
      evidence_ids: z.array(z.string()).min(1),
      reasoning_link: z.strictObject({
        customer_need_quote: z.string(),
        brochure_quote: z.string(),
        link_statement: z.string(),
      }),
    })
    .optional(),
  claims: z.array(z.strictObject({ text: z.string(), evidence_ids: z.array(z.string()) })),
  estimate_ref: z.string().optional(),
  next_question: z.string().optional(),
});

export type SubmitAnswer = z.infer<typeof SubmitAnswer>;
