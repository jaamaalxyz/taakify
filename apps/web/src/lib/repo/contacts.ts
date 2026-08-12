// Contacts repo layer — mirrors GET/POST /api/contacts and PATCH
// /api/contacts/:id in apps/api/src/routes/contacts.ts.
import { db, ready } from "../db/pglite.js";
import { enqueue } from "../sync/outbox.js";
import type { Contact } from "@taakify/shared";

export async function listContacts(householdId: string): Promise<Contact[]> {
  await ready;
  const { rows } = await db.query<Contact>(
    `SELECT id, name, phone, email, linked_user_id, updated_at FROM contact
     WHERE household_id = $1 AND deleted_at IS NULL ORDER BY name`,
    [householdId]
  );
  return rows;
}

export interface CreateContactInput {
  householdId: string;
  name: string;
  phone?: string;
  email?: string;
  createdBy: string;
}

// Returns the client-generated id, which is also the id the server row
// will end up with (see books.ts's header comment for the general
// client-supplied-id rationale — POST /api/contacts follows the same
// pattern).
export async function createContact(input: CreateContactInput): Promise<string> {
  await ready;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await enqueue(
    "/api/contacts",
    "POST",
    { id, householdId: input.householdId, name: input.name, phone: input.phone, email: input.email },
    {
      sql: `INSERT INTO contact (id, household_id, name, phone, email, created_by, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      params: [id, input.householdId, input.name, input.phone ?? null, input.email ?? null, input.createdBy, now],
    }
  );
  return id;
}

export interface UpdateContactInput {
  name?: string;
  phone?: string | null;
  email?: string | null;
}

export async function updateContact(contactId: string, input: UpdateContactInput): Promise<void> {
  await ready;
  const allowed = ["name", "phone", "email"] as const;
  const sets: string[] = [];
  const params: unknown[] = [contactId];
  let i = 2;
  for (const key of allowed) {
    if (key in input) {
      sets.push(`${key} = $${i}`);
      params.push((input as Record<string, unknown>)[key]);
      i++;
    }
  }
  if (!sets.length) return;

  await enqueue(`/api/contacts/${contactId}`, "PATCH", input, {
    sql: `UPDATE contact SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    params,
  });
}
