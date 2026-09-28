/**
 * ForgeSettingRow — WP-S2 (v2.9.0): one Forge setting, redesigned for a
 * beginner. Replaces the old five-column `<tr>` (Status / Setting / Value /
 * From / What it does, see the owner's Settings screenshot for this work
 * package: words breaking mid-word in narrow columns, a raw terminal command
 * under every description) with a single row that reads top to bottom:
 *
 *   plain-language NAME · small technical key · small source badge
 *   one-line explanation (the schema's own `desc`, straight from the API)
 *   a collapsed "For the command line" detail — never open by default,
 *     never shown outside that detail
 *   the real, editable control (unchanged ForgeSettingControl) on the side
 *
 * `ForgeSettingControl` itself is untouched by this work package (its
 * confirm-modal, gate-hook lockout and revert-on-failure behaviour are
 * already covered by settings-forge-config-section.test.tsx) — this
 * component only supplies the plain-language framing around it.
 *
 * Responsive: at >620px this is a plain row (label column + control column),
 * matching every other settings row in this view (see .fw-settings__row in
 * settings.css). At <=620px `.fw-fsetting`'s own media query in settings.css
 * turns it into a stacked card — no JS breakpoint detection needed, so a
 * unit test can assert the `fw-fsetting` class directly without mocking
 * matchMedia.
 */

import { Machine } from '@/components/primitives';
import type { GatewayForgeSetting } from '@/prototype/state/gateway-capabilities';
import { ForgeSettingControl } from './ForgeSettingControl';
import { forgeSetCommand, forgeSourceBadge, labelForSetting } from './forge-setting-presentation';

export interface ForgeSettingRowProps {
  readonly projectName: string;
  readonly setting: GatewayForgeSetting;
  readonly onChanged: () => void;
  /** The footnote number this setting carries in the Footnotes panel below,
   *  or `undefined` for a setting with no disclosure/flags to footnote. */
  readonly footnoteRef?: number;
}

export function ForgeSettingRow({ projectName, setting, onChanged, footnoteRef }: ForgeSettingRowProps) {
  const name = labelForSetting(setting.key);
  const badge = forgeSourceBadge(setting.source);
  const command = forgeSetCommand(setting);

  return (
    <div className="fw-fsetting">
      <div className="fw-fsetting__text">
        <div className="fw-fsetting__heading">
          <span className="fw-fsetting__name">{name}</span>
          <Machine muted className="fw-fsetting__key">
            {setting.key}
          </Machine>
          <span
            className={badge.changed ? 'fw-fsetting__badge is-changed' : 'fw-fsetting__badge'}
            title={badge.title}
          >
            {badge.changed ? <span className="fw-fsetting__badge-dot" aria-hidden="true" /> : null}
            {badge.text}
          </span>
        </div>
        <p className="fw-fsetting__desc">
          {setting.desc ?? 'No description available.'}
          {footnoteRef != null ? ` [${footnoteRef}]` : null}
        </p>
        <details className="fw-fsetting__cli">
          <summary>For the command line</summary>
          <Machine muted className="fw-fsetting__cli-command">
            {command}
          </Machine>
        </details>
      </div>
      <div className="fw-fsetting__control">
        <ForgeSettingControl projectName={projectName} setting={setting} onChanged={onChanged} />
      </div>
    </div>
  );
}
