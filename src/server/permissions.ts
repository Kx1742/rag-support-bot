import type { Role } from "../shop/staff.ts";

/**
 * What each role may do on the staff desk. Checked on the server for every request;
 * the desk UI only uses this list to hide buttons people can't use anyway.
 *
 * Customers have no desk access at all: they use the public site (chat, book a table,
 * look up or cancel their own booking with its reference + phone number).
 */
export const PERMISSIONS = {
  "till.use": "Ring up orders at the till",
  "orders.manage": "Move orders through the kitchen and cancel unpaid ones",
  "payments.take": "Take cash or card payments",
  "payments.refund": "Refund paid orders",
  "bookings.manage": "Create, seat and cancel bookings",
  "menu.soldOut": "Mark items sold out and set stock counts",
  "menu.edit": "Add menu items, change prices and options, hide items",
  "sales.view": "See sales totals",
  "reports.view": "See the end-of-day report",
  "staff.manage": "Add staff, change roles and reset PINs",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  staff: ["till.use", "orders.manage", "payments.take", "bookings.manage", "menu.soldOut"],
  manager: Object.keys(PERMISSIONS) as Permission[],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
