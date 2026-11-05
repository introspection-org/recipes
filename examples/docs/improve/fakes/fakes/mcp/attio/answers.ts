import { Type } from "typebox";

// Attio answers every tool in TOON. A record is a company or a deal, by the object asked for.
const Company = Type.Object(
  { id: Type.String(), name: Type.String() },
  { additionalProperties: false },
);
const Deal = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    stage: Type.String(),
    company_id: Type.String(),
  },
  { additionalProperties: false },
);
const Records = Type.Object(
  { records: Type.Array(Type.Union([Company, Deal])) },
  { additionalProperties: false },
);

export const answers = {
  "list-records": { format: "toon", schema: Records },
  "get-records-by-ids": { format: "toon", schema: Records },
  "update-record": {
    format: "toon",
    schema: Type.Object(
      { record_id: Type.String() },
      { additionalProperties: false },
    ),
  },
};
