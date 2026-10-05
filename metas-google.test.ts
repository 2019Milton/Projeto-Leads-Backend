import { expect, test } from "bun:test";
import { lerMetaCampanhaGoogle, planejarMetasCampanhaGoogle } from "./metas-google";

const meta = (category: string, origin: string, biddable: boolean) =>
  ({ resourceName: `customers/1/campaignConversionGoals/9~${category}~${origin}`, category, origin, biddable });

test("liga só a meta principal e as da plataforma; desliga o resto na campanha", () => {
  // Conta real (conferência): visualização de página contava no lance.
  const metas = [
    meta("PAGE_VIEW", "WEBSITE", true),
    meta("SUBMIT_LEAD_FORM", "GOOGLE_HOSTED", true),
    meta("QUALIFIED_LEAD", "WEBSITE", false),
    meta("CONVERTED_LEAD", "WEBSITE", false),
    meta("PURCHASE", "WEBSITE", true),
    meta("CONTACT", "WEBSITE", false)
  ];
  expect(planejarMetasCampanhaGoogle(metas, "SUBMIT_LEAD_FORM", ["QUALIFIED_LEAD", "CONVERTED_LEAD"])).toEqual([
    { resourceName: metas[0].resourceName, biddable: false },
    { resourceName: metas[2].resourceName, biddable: true },
    { resourceName: metas[3].resourceName, biddable: true },
    { resourceName: metas[4].resourceName, biddable: false }
  ]);
});

test("sem a meta principal ainda (formulário não aprovado), não mexe em nada", () => {
  const metas = [meta("PAGE_VIEW", "WEBSITE", true), meta("QUALIFIED_LEAD", "WEBSITE", false)];
  expect(planejarMetasCampanhaGoogle(metas, "SUBMIT_LEAD_FORM", ["QUALIFIED_LEAD"])).toBeNull();
  // Formulário do SITE (origem WEBSITE) não é o formulário do Google.
  expect(planejarMetasCampanhaGoogle([meta("SUBMIT_LEAD_FORM", "WEBSITE", true)], "SUBMIT_LEAD_FORM", [])).toBeNull();
});

test("WhatsApp usa CONTACT hospedado pelo Google; ações em DEFAULT entram como DEFAULT/WEBSITE", () => {
  const metas = [meta("CONTACT", "GOOGLE_HOSTED", false), meta("DEFAULT", "WEBSITE", false), meta("SIGNUP", "WEBSITE", true)];
  expect(planejarMetasCampanhaGoogle(metas, "CONTACT", ["DEFAULT"])).toEqual([
    { resourceName: metas[0].resourceName, biddable: true },
    { resourceName: metas[1].resourceName, biddable: true },
    { resourceName: metas[2].resourceName, biddable: false }
  ]);
});

test("meta UNKNOWN nunca entra no lote (o Google recusa alterar)", () => {
  // Metas reais da campanha ativa da conta do usuário 15 (conferência 05/10).
  const metas = [meta("DEFAULT", "WEBSITE", true), meta("SUBMIT_LEAD_FORM", "GOOGLE_HOSTED", true), meta("UNKNOWN", "GOOGLE_HOSTED", true)];
  expect(planejarMetasCampanhaGoogle(metas, "SUBMIT_LEAD_FORM", ["QUALIFIED_LEAD", "CONVERTED_LEAD"])).toEqual([
    { resourceName: metas[0].resourceName, biddable: false }
  ]);
});

test("já alinhada: nenhuma mudança", () => {
  const metas = [meta("SUBMIT_LEAD_FORM", "GOOGLE_HOSTED", true), meta("QUALIFIED_LEAD", "WEBSITE", true), meta("PAGE_VIEW", "WEBSITE", false)];
  expect(planejarMetasCampanhaGoogle(metas, "SUBMIT_LEAD_FORM", ["QUALIFIED_LEAD"])).toEqual([]);
});

test("lê a linha da API nos dois formatos de nome", () => {
  expect(lerMetaCampanhaGoogle({ campaignConversionGoal: { resourceName: "r", category: "PAGE_VIEW", origin: "WEBSITE", biddable: true } }))
    .toEqual({ resourceName: "r", category: "PAGE_VIEW", origin: "WEBSITE", biddable: true });
  expect(lerMetaCampanhaGoogle({ campaign_conversion_goal: { resource_name: "r", category: "X", origin: "Y" } })?.biddable).toBe(false);
  expect(lerMetaCampanhaGoogle({})).toBeNull();
});
