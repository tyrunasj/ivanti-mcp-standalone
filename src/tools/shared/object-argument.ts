// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * What an `object` argument says — once.
 *
 * The long form was copied word for word into fourteen tools, so every request re-sent the same
 * fact fourteen times, and the manifest is re-sent with every request of every conversation. It
 * now lives on get_object_metadata alone — the tool the instructions send a model to before it
 * composes anything — and every other tool keeps only what a caller must not get wrong: which
 * spellings work, and where the names come from. A wrong name is still refused with suggestions,
 * which is where the rest of the lesson is taught, at the moment it is needed.
 */
export const OBJECT_ARGUMENT =
  'Business Object, as `Incident#`, `Incidents` or `incident` — any of the three. Names are ' +
  'tenant-specific: take them from list_business_objects.';

export const OBJECT_ARGUMENT_IN_FULL =
  'Business Object, in any of the three forms Ivanti spells them — the AdminUI id, the ' +
  'entity set, or the entity (`Incident#` / `Incidents` / `incident`, and the same ' +
  'shape for a Business Object this tenant defined itself). Names are tenant-specific: ' +
  'take them from list_business_objects rather than assuming the ones Ivanti ships.';
