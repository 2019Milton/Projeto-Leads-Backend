import os
import subprocess

REPOSITORIOS = [
    {
        "nome": "Frontend",
        "caminho": r"C:\Users\perei\Projeto-Leads"
    },
    {
        "nome": "Backend",
        "caminho": r"C:\Users\perei\Projeto-Leads-Backend"
    }
]

mensagem_commit = input("Mensagem do commit: ").strip()

if not mensagem_commit:
    mensagem_commit = "update projeto"

for repo in REPOSITORIOS:

    print(f"\n🚀 Atualizando {repo['nome']}")

    os.chdir(repo["caminho"])

    # 🔄 Atualiza repositório antes
    print("\n⬇ Executando: git pull")

    pull = subprocess.run(
        "git pull",
        shell=True,
        text=True
    )

    if pull.returncode != 0:
        print("❌ Erro no git pull")
        continue

    # 🔍 Verifica alterações
    status = subprocess.run(
        "git status --porcelain",
        shell=True,
        text=True,
        capture_output=True
    )

    if not status.stdout.strip():
        print("✅ Nada para commitar.")
        continue

    comandos = [
        "git add .",
        f'git commit -m "{mensagem_commit}"',
        "git push"
    ]

    for comando in comandos:

        print(f"\n➡ Executando: {comando}")

        resultado = subprocess.run(
            comando,
            shell=True,
            text=True
        )

        if resultado.returncode != 0:
            print(f"❌ Erro ao executar: {comando}")
            break

print("\n✅ Processo finalizado.")