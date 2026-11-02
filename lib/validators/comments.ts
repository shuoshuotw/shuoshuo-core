import { z } from "zod";
import { commentContent } from "@/lib/validators/common";

export const commentBody = z.strictObject({ content: commentContent });
