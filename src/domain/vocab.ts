// This file holds the shared words the whole app agrees on: equipment models and task tags.
// Equipment models come straight from the brochure manifest, so there is only one list to keep up to date.

import { z } from "zod";
import { manifest } from "./manifest";

const productIds = [...new Set(manifest.flatMap((entry) => entry.product_ids))];

export const EquipmentModel = z.enum(productIds as [string, ...string[]]);

export const EquipmentOrOther = z.union([EquipmentModel, z.string().regex(/^other:.+/)]);

export const TaskTag = z.enum([
  "filter_cloth_replacement",
  "hydraulic_service",
  "emergency_repair",
  "inspection",
  "calibration",
  "commissioning",
  "control_system_upgrade",
  "pump_overhaul",
  "cleaning",
  "preventive_maintenance",
]);
