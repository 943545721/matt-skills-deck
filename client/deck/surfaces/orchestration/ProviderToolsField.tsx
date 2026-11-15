import { Text, View } from "react-native";
import { installCommandOf, type installRecipeFor } from "../../../../shared/provider-install.ts";
import { PixelButton } from "../../pixel.tsx";
import type { CardContext } from "./providerCardStyles.ts";
import type { ProviderDiagnostics } from "./useProviderDiagnostics.ts";

function InstallControls({
  ctx,
  diagnostics,
  recipe,
}: {
  ctx: CardContext;
  diagnostics: ProviderDiagnostics;
  recipe: NonNullable<ReturnType<typeof installRecipeFor>>;
}) {
  const { skin, t, provider, styles } = ctx;
  if (!diagnostics.confirmingFor(provider.id)) {
    return (
      <PixelButton
        skin={skin}
        mini
        variant="ghost"
        label={t("orch.install")}
        disabled={diagnostics.anyInstalling}
        onPress={() => diagnostics.setConfirmId(provider.id)}
      />
    );
  }
  return (
    <>
      <Text style={styles.dim}>{installCommandOf(recipe)}</Text>
      <PixelButton
        skin={skin}
        mini
        label={t("orch.install")}
        disabled={diagnostics.anyInstalling}
        onPress={() => void diagnostics.install(provider.id)}
      />
      <PixelButton
        skin={skin}
        mini
        variant="ghost"
        label={t("orch.cancel")}
        onPress={() => diagnostics.setConfirmId(null)}
      />
    </>
  );
}

function NoticeBlock({ ctx, diagnostics }: { ctx: CardContext; diagnostics: ProviderDiagnostics }) {
  const { styles, provider } = ctx;
  const notice = diagnostics.noticeFor(provider.id);
  if (!notice) return null;
  return (
    <View style={styles.output}>
      {notice.text.split("\n").map((text, index) => (
        <Text key={`${index}-${text.slice(0, 8)}`} style={notice.bad ? styles.bad : styles.outputText} selectable>
          {text}
        </Text>
      ))}
    </View>
  );
}

export function ToolsField({
  ctx,
  diagnostics,
  installable,
  recipe,
}: {
  ctx: CardContext;
  diagnostics: ProviderDiagnostics;
  installable: boolean;
  recipe: ReturnType<typeof installRecipeFor>;
}) {
  const { skin, t, provider, styles } = ctx;
  const diagnosing = diagnostics.diagnosingFor(provider.id);
  return (
    <>
      <View style={styles.tools}>
        <PixelButton
          skin={skin}
          mini
          variant="ghost"
          label={diagnosing ? t("orch.diagnosing") : t("orch.diagnose")}
          disabled={diagnosing || diagnostics.anyInstalling}
          onPress={() => void diagnostics.diagnose(provider.id)}
        />
        {installable && recipe ? <InstallControls ctx={ctx} diagnostics={diagnostics} recipe={recipe} /> : null}
      </View>
      <NoticeBlock ctx={ctx} diagnostics={diagnostics} />
    </>
  );
}
