import type { AssistantTools } from "../rag/assistant.ts";
import type { ToolCall, ToolCallRecord, ToolDefinition } from "../types.ts";
import type { PublicBooking } from "./bookings.ts";
import { ShopError } from "./errors.ts";
import type { Shop } from "./shop.ts";
import { addDays, describeDate, fromMinutes, weekdayOf } from "./time.ts";

const DEFINITIONS: ToolDefinition[] = [
  {
    name: "check_availability",
    description:
      "Check table availability. With a time: says whether that exact time is free and suggests close alternatives. Without a time: lists all free start times that day.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
        party_size: { type: "integer", description: "Number of people" },
        time: { type: "string", description: "Optional start time in 24-hour HH:MM format" },
      },
      required: ["date", "party_size"],
    },
  },
  {
    name: "create_booking",
    description:
      "Book a table. Only call this after the customer has seen a summary of the details and clearly confirmed they want to book.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
        time: { type: "string", description: "Start time in 24-hour HH:MM format" },
        party_size: { type: "integer", description: "Number of people" },
        name: { type: "string", description: "Name for the booking" },
        phone: { type: "string", description: "Customer's phone number" },
        notes: { type: "string", description: "Optional requests, e.g. high chair or birthday" },
      },
      required: ["date", "time", "party_size", "name", "phone"],
    },
  },
  {
    name: "cancel_booking",
    description: "Cancel an existing booking. Needs the booking reference (like BB-7K3QX) and the phone number used to book.",
    parameters: {
      type: "object",
      properties: {
        reference: { type: "string", description: "Booking reference, e.g. BB-7K3QX" },
        phone: { type: "string", description: "Phone number used for the booking" },
      },
      required: ["reference", "phone"],
    },
  },
];

/** Booking tools for the chat assistant, backed by the shop's real booking rules. */
export function createBookingTools(shop: Shop): AssistantTools {
  const run = async (call: ToolCall): Promise<unknown> => {
    const a = call.args;
    try {
      switch (call.name) {
        case "check_availability": {
          const date = String(a.date ?? "");
          const partySize = Number(a.party_size);
          if (a.time) return { date, partySize, ...shop.bookings.check(date, String(a.time), partySize) };
          return { date, partySize, ...shop.bookings.availableTimes(date, partySize) };
        }
        case "create_booking": {
          const booking = shop.bookings.create(
            {
              date: String(a.date ?? ""),
              time: String(a.time ?? ""),
              partySize: Number(a.party_size),
              name: String(a.name ?? ""),
              phone: String(a.phone ?? ""),
              notes: String(a.notes ?? ""),
            },
            "chat",
          );
          return { booked: true, booking: shop.bookings.toPublic(booking) };
        }
        case "cancel_booking": {
          const booking = shop.bookings.cancelByReference(String(a.reference ?? ""), String(a.phone ?? ""));
          return { cancelled: true, booking: shop.bookings.toPublic(booking) };
        }
        default:
          return { error: `Unknown tool ${call.name}` };
      }
    } catch (err) {
      // Rule violations go back to the model so it can explain them; anything else is a real bug.
      if (err instanceof ShopError) return { error: err.message };
      throw err;
    }
  };

  return {
    runner: { definitions: DEFINITIONS, run },
    instructions: () => bookingInstructions(shop),
    toAction: (call: ToolCallRecord) => {
      const result = call.result as { booked?: boolean; cancelled?: boolean; booking?: PublicBooking } | null;
      if (result?.booked && result.booking) return { name: "booking_created", data: result.booking };
      if (result?.cancelled && result.booking) return { name: "booking_cancelled", data: result.booking };
      return null;
    },
  };
}

function bookingInstructions(shop: Shop): string {
  const { date, minutes } = shop.bookings.today();
  const { booking, timezone } = shop.config;
  // The model is bad at calendar maths, so spell out the next two weeks.
  const calendar = Array.from({ length: 14 }, (_, i) => {
    const d = addDays(date, i);
    return `${weekdayOf(d)} ${d}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`;
  }).join(", ");

  return `Table bookings:
- You can check availability, book tables and cancel bookings with your tools. Tool results are trusted information, like the sources.
- Today is ${describeDate(date)}, the time is ${fromMinutes(minutes)} (${timezone}). Upcoming dates: ${calendar}.
- To book you need: date, time, party size (1-${shop.bookings.maxPartySize}), the customer's name and phone number. Ask for anything missing, a few things at a time.
- Always call check_availability before offering a time. If it's not available, offer the alternatives it returns.
- Before calling create_booking, summarise the date, time, party size, name and phone, and ask the customer to confirm. Only call create_booking after a clear "yes".
- Never say a booking is made unless create_booking returned booked: true. Always give the booking reference.
- Bookings last ${booking.durationMinutes} minutes and can be made up to ${booking.maxDaysAhead} days ahead with at least ${booking.minNoticeMinutes} minutes' notice.
- To cancel, ask for the booking reference and phone number, then call cancel_booking.
- Times in tool calls use 24-hour HH:MM. Talk to customers in a friendly format like "10:30 am".`;
}
