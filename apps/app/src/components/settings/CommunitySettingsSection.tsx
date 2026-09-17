import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const DISCORD_INVITE_URL = "https://discord.gg/kvBU6tJhcJ";
const GITHUB_REPO_URL = "https://github.com/get-bb/bb";

interface CommunityLinkRowProps {
  description: string;
  href: string;
  icon: IconName;
  label: string;
  openLabel: string;
}

function CommunityLinkRow({
  description,
  href,
  icon,
  label,
  openLabel,
}: CommunityLinkRowProps) {
  return (
    <SettingsWithControl label={label} description={description}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs"
        aria-label={openLabel}
        onClick={() => {
          openUrlInExternalBrowser(href);
        }}
      >
        <Icon name={icon} className="size-3.5 shrink-0" />
        {openLabel}
        <Icon
          name="ExternalLink"
          className="size-3 shrink-0 text-muted-foreground"
        />
      </Button>
    </SettingsWithControl>
  );
}

export function CommunitySettingsSection() {
  return (
    <SettingsSection
      title="Upstream community"
      description="These links lead to the upstream project's community and source code."
    >
      <div className="space-y-5">
        <CommunityLinkRow
          label="Upstream Discord"
          description="Discussion and announcements for the upstream project."
          href={DISCORD_INVITE_URL}
          icon="Discord"
          openLabel="Join upstream Discord"
        />
        <CommunityLinkRow
          label="Upstream GitHub"
          description="Source code, issues, and releases for the upstream project. ARC-specific issues belong with ARC."
          href={GITHUB_REPO_URL}
          icon="Github"
          openLabel="View upstream on GitHub"
        />
      </div>
    </SettingsSection>
  );
}
