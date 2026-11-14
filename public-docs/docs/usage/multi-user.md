---
title: Several accounts
---

Timon is built for one person: Free gives every feature and plugin to **one account**, the administrator created at the first run (replacing the whole interface with a third-party layout, White Label, needs a licence that includes it). Letting other people sign in to the same Timon is the job of **Multi-user**, a separate plugin reserved for a **pro licence**. Timon itself does not invite, add or organise accounts.

## With Multi-user

Once your pro licence is active and Multi-user is installed and on, its **Team** page appears in the menu. From there an administrator invites people, sorts them into groups, decides what each group may do and reads the activity log. See [Plugin gallery](plugins-gallery.md) to turn it on or off.

Each person keeps their own missions, projects and settings; what they may see beyond their own work is what their groups allow.

## Access to the Providers screen

**Settings → AI models → Providers** is offered to the other accounts at one of three levels, chosen for each permission set on the Team page (**Permissions**, then **Providers screen**):

| Level | What the account sees and does |
|---|---|
| **Full access** | Like the superadmin: every section of a provider's page (Connection, API key, Program, its own settings, Models), adding and removing providers, switching them on and off. The Program section decides which program Timon runs on this machine: give this level only to people you would let do that. |
| **Own accounts only** | The list of providers, read only, and on a provider's page the **Connection** section with **its own** [subscription accounts](./subscription-accounts.md): add one, sign it in, rename it, delete it. Nothing else: no program, API key, settings, models, on/off switch or new provider. |
| **Hidden** | The screen does not appear: no tab, no settings search result, no link from a notification. |

The superadmin always has full access. An account in several groups gets the widest level any of them gives. The **Employee** permission set a new installation starts with gives **Own accounts only**, the level we recommend for a new account; a permission set you create gives **Hidden** until you pick another level.

When you update an installation whose accounts managed their own subscription accounts before these levels existed, every permission set that said nothing about providers is given **Own accounts only** once, so nobody loses what they had. Change it afterwards as you wish.

## Without it

If the licence ends, or Multi-user is removed or turned off, **only the administrator keeps access**. The other accounts are suspended, never deleted: they cannot sign in, but their missions, settings and data stay where they are. The administrator sees a card explaining why. Access comes back, unchanged, as soon as the pro licence and Multi-user are both there again.

## Upgrading an installation that already has several accounts

Earlier versions of Timon managed roles, groups and invitations themselves. When this version first starts, it keeps all of them aside, in a file of its data directory that only your own account can read, and Multi-user picks them up when it first starts. Nothing is lost if you update Timon before installing Multi-user: until then, the other accounts are suspended as described above.

## Recovering an account from the command line

Two commands stay in Timon, for the operator of the machine, with or without Multi-user:

```bash
timon user list
timon user reset-password <email-or-id>
```

The second prints a temporary password once; hand it over yourself. See the [command-line reference](cli-reference.md).
