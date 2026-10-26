import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sdkDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sdkDir, "../..");
const sourceFiles = {
  chat: path.join(repoRoot, "apps/desktop/src/shared/types/chat.ts"),
  personalChats: path.join(repoRoot, "apps/desktop/src/shared/types/personalChats.ts"),
  sdk: path.join(sdkDir, "src/types.ts"),
};
const program = ts.createProgram(Object.values(sourceFiles), {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  strict: true,
  noEmit: true,
});
const checker = program.getTypeChecker();

function exportedType(fileName, typeName) {
  const source = program.getSourceFile(fileName);
  const symbol = source && checker.getSymbolAtLocation(source);
  const typeSymbol = symbol && checker.getExportsOfModule(symbol).find((item) => item.name === typeName);
  if (!typeSymbol) throw new Error(`${path.relative(repoRoot, fileName)} does not export ${typeName}`);
  const declaration = typeSymbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(typeSymbol) : typeSymbol;
  return checker.getDeclaredTypeOfSymbol(declaration);
}

const pairs = [
  ["AgentChatEvent", "chat", "AgentChatEvent"],
  ["AgentChatEventEnvelope", "chat", "AgentChatEventEnvelope"],
  ["AgentChatSessionSummary", "chat", "AgentChatSessionSummary"],
  ["AgentChatModelCatalog", "chat", "AgentChatModelCatalog"],
  ["AgentChatModelCatalogGroup", "chat", "AgentChatModelCatalogGroup"],
  ["AgentChatModelCatalogProvider", "chat", "AgentChatModelCatalogProvider"],
  ["AgentChatModelCatalogSubsection", "chat", "AgentChatModelCatalogSubsection"],
  ["AgentChatModelCatalogModel", "chat", "AgentChatModelCatalogModel"],
  ["PendingInputOption", "chat", "PendingInputOption"],
  ["PendingInputQuestion", "chat", "PendingInputQuestion"],
  ["PendingInputRequest", "chat", "PendingInputRequest"],
  ["PersonalChatPendingInputsResult", "personalChats", "PendingInputsResult"],
];
const failures = [];

for (const [sourceName, sourceKey, sdkName] of pairs) {
  const sourceType = exportedType(sourceFiles[sourceKey], sourceName);
  const sdkType = exportedType(sourceFiles.sdk, sdkName);
  if (!checker.isTypeAssignableTo(sourceType, sdkType)) {
    failures.push(`${sourceName} no longer fits the SDK wire type ${sdkName}`);
  }
}

for (const typeName of ["PendingInputSource", "PendingInputKind"]) {
  const sourceType = exportedType(sourceFiles.chat, typeName);
  const sdkType = exportedType(sourceFiles.sdk, typeName);
  const values = (type) => type.isUnion() ? type.types.map((item) => item.value).sort() : [type.value];
  if (JSON.stringify(values(sourceType)) !== JSON.stringify(values(sdkType))) {
    failures.push(`${typeName} values differ between desktop and SDK`);
  }
}

if (failures.length) {
  process.stderr.write(`SDK wire type drift:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${pairs.length + 2} SDK wire contracts against desktop types.\n`);
}
