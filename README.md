# Feuch Game

Jeu social expérimental à rôles secrets, pour 3 à 5 joueurs sur leurs téléphones.
Un Worker Cloudflare utilise Durable Objects et WebSockets pour synchroniser les
salons.

## Présent dans le code

- Création d'un salon, accès par code et lien d'invitation.
- Pseudos, présence, état « prêt » et distribution privée des rôles.
- Phases nuit, discussion, défis, vote et résolution.
- Actions de rôles, liens entre joueurs, conversion, points de Vice et boucliers.
- Défis avec acceptation du joueur et validation par l'hôte.
- Conditions de victoire et affichage du résultat.
- Proposition de défis par Octopus avec secours local si le service est indisponible.

Ces mécanismes sont implémentés dans `src/index.ts`. Leur présence dans le code
ne remplace pas une partie de validation sur plusieurs appareils.

## Essayer une partie

1. L'hôte crée un salon et partage le lien ou le code.
2. Chaque joueur rejoint, choisit un pseudo et appuie sur « Prêt ».
3. L'hôte distribue les rôles ; chacun garde son écran secret.
4. Suivre les indications et les phases affichées jusqu'au résultat.

## Développement local

```bash
npm install
npm run dev
npm run typecheck
```

## Déploiement

Le workflow de déploiement est déclenché manuellement et vérifie les types ainsi
que le bundle Wrangler avant publication. Pour un déploiement local autorisé :

```bash
npx wrangler login
npm run deploy
```

## Limites à vérifier

- La reprise après coupure n'est pas transparente : l'interface propose de recharger.
- Les actions d'hôte sont contrôlées par l'identité de joueur du salon ; cela ne
  constitue pas une authentification de compte.
- Aucun test automatisé de partie complète n'est livré actuellement.
- Avant une démonstration : jouer une partie entière à 3–5 appareils, tester une
  déconnexion et vérifier les votes, les actions de rôles et la fin de partie.

Le projet reste expérimental. Les illustrations et la finition peuvent évoluer.
