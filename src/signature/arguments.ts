/**
 * The arguments each `signature` command takes, as the model sees them.
 * `scripts/generate-tool-schemas.mjs` turns each `Signature<Command>Arguments`
 * type into the JSON Schema in `arguments.generated.ts`: a field's doc comment
 * is its description and its tags are its limits.
 */

/**
 * The envelope's handle, provider:id, as create returned it
 * @minLength 1
 */
type EnvelopeHandle = string;

/** Someone who signs or receives a copy */
interface Recipient {
  /**
   * Their full name, exactly as on their Name: line for a signer
   * @minLength 1
   */
  name: string;
  /**
   * Their email address
   * @minLength 3
   */
  email: string;
  /**
   * 1 goes first; equal numbers sign at the same time
   * @asType integer
   * @minimum 1
   * @maximum 99
   * @default 1
   */
  routing_order?: number;
}

export interface SignatureCreateArguments {
  /**
   * The final .docx under outputs/, with no tracked changes or comments
   * @minLength 1
   */
  path: string;
  /**
   * The email subject signers see
   * @minLength 1
   * @maxLength 100
   */
  subject: string;
  /**
   * A short note in the email
   * @maxLength 2000
   */
  message?: string;
  /**
   * Who signs, each found by their Name: line in the signature block
   * @minItems 1
   * @maxItems 10
   */
  signers: Recipient[];
  /**
   * Who receives a copy once the signers before them have signed
   * @maxItems 10
   */
  cc?: Recipient[];
}

export interface SignatureSendArguments {
  envelope: EnvelopeHandle;
}

export interface SignatureGetArguments {
  envelope: EnvelopeHandle;
}
