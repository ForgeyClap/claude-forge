// Owner-verhoging (owner-opdracht 2026-08-01): een prompt van de GEVERIFIEERDE
// eigenaar mag op volledige rechten draaien.
//
// Kernpunt: de verhoging hangt aan de PERSOON die het bericht stuurde, niet aan
// het kanaal of de projectinstelling. Daarom wordt de modus per bericht afgeleid
// uit `item.senderId` — de afzender die de PermissionGateway al per bericht heeft
// geverifieerd — en nooit alleen uit `project.permissionMode`.
//
// Drie regels, in deze volgorde:
//  1. FAIL CLOSED — lege/ongeldige ownerlijst, ontbrekende afzender of een niet
//     aantoonbare owner geeft NOOIT een verhoging. Bij twijfel: niet verhogen.
//  2. Een eigen BEPERKING wint. Zet de owner een project bewust op read-only
//     (`/forge write off` → 'default') of op 'plan', dan blijft dat staan: de
//     verhoging verhoogt, maar overrulet nooit een expliciete eigen rem.
//  3. Elke (geweigerde) verhoging is een auditgebeurtenis. Nooit stil.
//
// Het opgeslagen project wordt NOOIT gemuteerd — de verhoging leeft alleen in de
// kopie die naar de runner gaat, zodat 'bypassPermissions' nooit in mappings.json
// belandt en per ongeluk permanent wordt.

export const OWNER_ELEVATED_MODE = 'bypassPermissions';

// Alleen vanuit deze modus wordt verhoogd. Alles wat hier niet in staat, geldt
// als een bewuste beperking (allowlist, geen blocklist: een nieuwe/onbekende
// modus leidt dus tot GEEN verhoging in plaats van per ongeluk wél).
export const ELEVATABLE_MODES = Object.freeze(['acceptEdits']);

export function isVerifiedOwner(senderId, ownerUserIds) {
  if (!Array.isArray(ownerUserIds) || ownerUserIds.length === 0) return false;
  if (typeof senderId !== 'string' || senderId.trim() === '') return false;
  // Exacte string-vergelijking op niet-lege owner-ID's: geen prefix, geen
  // case-insensitive match, geen impliciete type-conversie. De AFZENDER wordt
  // bewust NIET genormaliseerd/getrimd — dat is onvertrouwde invoer, en een
  // "bijna gelijk" ID hoort geen volledige rechten te krijgen. De ownerlijst
  // komt uit onze eigen config (die trimt al) en mag wel opgeschoond worden.
  return ownerUserIds.some((id) => typeof id === 'string' && id.trim() !== '' && id === senderId);
}

// Wat mag dit ENE bericht? → { mode, elevated, reason }
export function resolveEffectivePermissionMode({ project, item, ownerUserIds }) {
  const owners = typeof ownerUserIds === 'function' ? ownerUserIds() : ownerUserIds;
  const projectMode = project?.permissionMode ?? null;
  const withheld = (reason) => ({ mode: projectMode, elevated: false, reason });

  if (!project) return withheld('no_project');
  if (!Array.isArray(owners) || owners.filter((id) => typeof id === 'string' && id.trim()).length === 0) {
    return withheld('no_owner_list');
  }
  const senderId = item?.senderId;
  if (typeof senderId !== 'string' || senderId.trim() === '') return withheld('no_sender');
  if (!isVerifiedOwner(senderId, owners)) return withheld('not_owner');
  if (projectMode === OWNER_ELEVATED_MODE) return withheld('already_elevated');
  // Regel 2: de eigen rem van de owner wint van zijn eigen verhoging.
  if (!ELEVATABLE_MODES.includes(projectMode)) return withheld('project_restricted');

  return { mode: OWNER_ELEVATED_MODE, elevated: true, reason: 'verified_owner', from: projectMode };
}

// Drop-in vervanger voor `resolveProject` van de claude-runner: zoekt het project
// op en geeft een KOPIE terug waarin de permissiemodus per bericht is bepaald.
export function createOwnerAwareProjectResolver({ findProject, ownerUserIds, audit }) {
  return function resolveProjectForItem(item) {
    const project = findProject?.(item?.projectId) ?? null;
    if (!project) return null;

    const { mode, elevated, reason, from } = resolveEffectivePermissionMode({
      project,
      item,
      ownerUserIds,
    });

    // Auditvorm: WELKE modus, WELK project, WELK bericht — nooit een ID-waarde.
    // De afzender heet hier altijd 'owner'/'niet-owner', want alleen dat feit is
    // relevant en het Discord-ID is een persoonsgegeven.
    const base = {
      projectId: project.projectId ?? null,
      messageId: item?.messageId ?? null,
      itemId: item?.id ?? null,
      sender: 'owner',
    };
    if (elevated) {
      audit?.record('owner_permission_elevated', { ...base, from: from ?? null, to: mode });
    } else {
      audit?.record('owner_elevation_withheld', {
        ...base,
        sender: reason === 'not_owner' || reason === 'no_sender' ? 'niet-owner' : 'owner',
        mode,
        reason,
      });
    }

    return { ...project, permissionMode: mode };
  };
}
