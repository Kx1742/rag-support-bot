/** A rule was broken (bad input, slot taken...). The message is safe to show to users. */
export class ShopError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ShopError";
    this.code = code;
  }
}
