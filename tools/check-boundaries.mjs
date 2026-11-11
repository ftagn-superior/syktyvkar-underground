import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const allowed = { contracts: [], simulation: ['contracts'], protocol: ['contracts'] };
let errors = 0;
async function walk(directory, visit) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isDirectory()) await walk(file, visit);
    else if (file.endsWith('.ts') && !file.endsWith('.test.ts')) await visit(file);
  }
}
for (const [name, dependencies] of Object.entries(allowed)) {
  await walk(`packages/${name}/src`, async (file) => {
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const check = (specifier) => {
      const internal = /^@su\/([^/]+)/.exec(specifier)?.[1];
      const invalid =
        (internal && !dependencies.includes(internal)) ||
        (name === 'contracts' && !specifier.startsWith('.')) ||
        (name === 'simulation' && /colyseus/.test(specifier));
      if (invalid) {
        console.error(`${file}: forbidden dependency ${specifier}`);
        errors++;
      }
    };
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        check(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        check(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  });
}
if (errors) process.exit(1);
console.log('Package boundaries OK.');
