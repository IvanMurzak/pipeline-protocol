import { describe, expect, test } from "bun:test";
import {
  APPROVAL_ROLES,
  ApprovalSchema,
  QuestionSchema,
  type Question,
} from "./question.js";

/**
 * The shared needs-input question shape, focusing on the T3-14 additive
 * `approval` marker: a question WITHOUT it is byte-identical to before, one
 * WITH it carries a `required_role` from the fixed membership-role space, and a
 * bad role is rejected.
 */

describe("QuestionSchema — approval gate marker (T3-14, additive)", () => {
  test("a question WITHOUT `approval` still parses and carries none (byte-identical)", () => {
    const q = QuestionSchema.parse({ text: "Proceed?", question_id: "q-1" });
    expect(q.approval).toBeUndefined();
    // Round-trips with no extra keys — an ungated question is unchanged.
    expect(Object.keys(q).sort()).toEqual(["question_id", "text"]);
  });

  test("a question WITH `approval.required_role` parses and preserves the role", () => {
    const q = QuestionSchema.parse({
      text: "Deploy to production?",
      question_id: "q-2",
      approval: { required_role: "admin" },
    });
    expect(q.approval?.required_role).toBe("admin");
  });

  test("every membership role is accepted as a required_role", () => {
    for (const role of APPROVAL_ROLES) {
      const q = QuestionSchema.parse({ text: "ok?", approval: { required_role: role } });
      expect(q.approval?.required_role).toBe(role);
    }
  });

  test("`approval: null` is tolerated (explicitly ungated)", () => {
    const q = QuestionSchema.parse({ text: "ok?", approval: null });
    expect(q.approval).toBeNull();
  });

  test("an unknown required_role is rejected", () => {
    expect(
      QuestionSchema.safeParse({ text: "ok?", approval: { required_role: "superuser" } }).success,
    ).toBe(false);
    expect(QuestionSchema.safeParse({ text: "ok?", approval: {} }).success).toBe(false);
  });

  test("ApprovalSchema tolerates (preserves) additive-forward sibling fields", () => {
    const parsed = ApprovalSchema.parse({ required_role: "owner", reason: "sensitive" });
    expect(parsed.required_role).toBe("owner");
    expect((parsed as Record<string, unknown>).reason).toBe("sensitive");
  });

  test("the inferred type carries the optional approval field", () => {
    const q: Question = { text: "ok?", approval: { required_role: "member" } };
    expect(q.approval?.required_role).toBe("member");
  });
});
