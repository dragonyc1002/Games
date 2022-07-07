import { ButtonInteraction, InteractionCollector, MessageActionRow, MessageButton, MessageSelectMenu, MessageSelectOptionData, SelectMenuInteraction } from 'discord.js';
import { DjsGameWrapper } from './DjsGameWrapper';
import { HZGError, ErrorCodes } from '../errors';
import { BigTwo } from '../games';
import { Player } from '../struct';
import { DjsBigTwoOptions, BigTwoStrings, BigTwoTrick, BigTwoTrickType, DjsInputResult } from '../types';
import { format, overwrite, sleep } from '../util/Functions';
import { bigTwo } from '../util/strings.json';

export class DjsBigTwo extends DjsGameWrapper {
  public strings: BigTwoStrings;

  protected game: BigTwo;
  protected inputMode: number;
  protected bundles: ({ messageId: string, menu: MessageSelectMenu, buttons: MessageButton[], selectedCards: number[] })[];
  protected buttonCollector: InteractionCollector<ButtonInteraction> | void;
  protected menuCollector: InteractionCollector<SelectMenuInteraction> | void;


  constructor({ players, source, time, strings }: DjsBigTwoOptions) {
    super({ source, time });
    this.game = new BigTwo({ players });

    this.strings = overwrite(JSON.parse(JSON.stringify(bigTwo)), strings);

    this.inputMode = 0b00;
    this.bundles = [];
    this.buttonCollector = undefined;
    this.menuCollector = undefined;
    this.playerAction = this.playerAction.bind(this);
    this.playerSelect = this.playerSelect.bind(this);
  }

  async initialize(): Promise<void> {
    if (!this.source.channel) {
      throw new HZGError(ErrorCodes.InvalidChannel);
    }

    const content = format(this.strings.nowPlayer, { player: `<@${this.game.playerManager.nowPlayer.id}>` });
    const components = [new MessageActionRow().addComponents(
      new MessageButton()
        .setCustomId('HZG_CTRL_leave')
        .setLabel(this.strings.controller.leave)
        .setStyle("DANGER"), 
      new MessageButton()
        .setCustomId('HZG_CTRL_cards')
        .setLabel(this.strings.controller.cards)
        .setStyle("SECONDARY")
    )];
    await super.initialize({ content, components });

    for (let i = 0; i < this.game.playerManager.playerCount; i++) {
      this.bundles[i] = {
        messageId: '', 
        menu: new MessageSelectMenu()
          .setCustomId('HZG_PLAY_select')
          .setPlaceholder(this.strings.player.menu)
          .setMinValues(1)
          .setMaxValues(5)
          .setOptions(this.getOptions(this.game.cards[i])), 
        buttons: [
          new MessageButton()
            .setCustomId('HZG_PLAY_play')
            .setLabel(this.strings.player.play)
            .setStyle("SUCCESS"), 
          new MessageButton()
            .setCustomId('HZG_PLAY_pass')
            .setLabel(this.strings.player.pass)
            .setStyle("DANGER"), 
        ], 
        selectedCards: []
      };
    }

    this.buttonCollector = this.source.channel.createMessageComponentCollector({
      filter: i => this.bundles.some(({ messageId }) => i.message.id === messageId) && i.customId.startsWith("HZG_PLAY"), 
      componentType: "BUTTON"
    });
    this.menuCollector = this.source.channel.createMessageComponentCollector({
      filter: i => this.bundles.some(({ messageId }) => i.message.id === messageId) && i.customId.startsWith("HZG_PLAY"), 
      componentType: "SELECT_MENU"
    });
  }

  protected async run(nowPlayer: Player): Promise<void> {
    let result: DjsInputResult;

    const input = await this.getBigTwoInput();

    if (nowPlayer.status.now === "LEFT") {
      return;
    }

    if (input === null) {
      result = this.idleToDo(nowPlayer);
    }
    else {
      result = this.playToDo(nowPlayer, input);
    }

    result = await this.update(result);
    if (result.endStatus) {
      await this.end(result.endStatus);
    }
  }

  async start(): Promise<void> {
    if (this.buttonCollector === undefined || this.menuCollector === undefined) {
      throw new HZGError(ErrorCodes.GameNotInitialized);
    }
    this.buttonCollector.on('collect', this.playerAction);
    this.menuCollector.on('collect', this.playerSelect);
    await super.start();
    this.buttonCollector.off('collect', this.playerAction);
    this.menuCollector.off('collect', this.playerSelect);
  }

  public async conclude(): Promise<void> {
    if (this.buttonCollector === undefined || this.menuCollector === undefined) {
      throw new HZGError(ErrorCodes.GameNotInitialized);
    }
    await super.conclude();
  }

  getEndContent(): string {
    const message = this.strings.endMessages;
    switch (this.game.status.now) {
      case "WIN":
        return format(message.win, { player: `<@${this.winner?.id}>` });
      case "IDLE":
        return message.idle;
      case "STOPPED":
        return message.stopped;
      case "DELETED":
        return message.deleted;
      default:
        return '';
    }
  }


  protected buttonFilter(): boolean {
    return false;
  }

  protected messageFilter(): boolean {
    return false;
  }

  protected async ctrlCollected(interaction: ButtonInteraction): Promise<void> {
    super.ctrlCollected(interaction);
    
    const args = interaction.customId.split('_');
    if (args[2] === 'cards') {
      if (!interaction.channel) {
        throw new HZGError(ErrorCodes.InvalidChannel);
      }

      const index = this.game.playerManager.getIndex(interaction.user.id);
      const content = format(this.strings.player.cards, { cards: this.cardsToString(this.game.cards[index]) });
      const components = [new MessageActionRow().addComponents(this.bundles[index].menu), new MessageActionRow().addComponents(...this.bundles[index].buttons)];

      this.bundles[index].messageId = (await interaction.reply({ content, components, ephemeral: true, fetchReply: true })).id;
    }
  }

  protected async playerAction(interaction: ButtonInteraction): Promise<void> {
    const index = this.game.playerManager.getIndex(interaction.user.id);
    if (index < 0) return;

    let content = format(this.strings.player.cards, { cards: this.cardsToString(this.game.cards[index]) }) + '\n';
    if (interaction.user.id !== this.game.playerManager.nowPlayer.id) {
      content += this.strings.player.notYourTurn;
      return await interaction.update({ content });
    }

    const args = interaction.customId.split('_');
    if (args[2] === 'play') {
      const cards = this.bundles[index].selectedCards;
      if (cards.length === 0) {
        content += this.strings.player.noSelection;
        return await interaction.update({ content });
      }
      this.conveyor.emit('cardsPlayed', JSON.parse(JSON.stringify(cards)));
      this.game.playerManager.players[index].addStep();
      this.game.play(cards);

      content = format(this.strings.player.cards, { cards: this.cardsToString(this.game.cards[index]) }) + '\n'
              + format(this.strings.player.played, { cards: this.cardsToString(cards), trick: this.trickToString(this.game.cardsToTrick(cards)) });

      this.bundles[index].menu
        .setMaxValues(Math.min(this.game.cards[index].length, 5))
        .setOptions(this.getOptions(this.game.cards[index]));
      const components = [new MessageActionRow().addComponents(this.bundles[index].menu), new MessageActionRow().addComponents(...this.bundles[index].buttons)];
      
      this.bundles[index].selectedCards = [];
      return await interaction.update({ content, components });
    }
    else if (args[2] === 'pass') {
      this.conveyor.emit('cardsPlayed', []);
      this.game.pass();
      const content = format(this.strings.player.cards, { cards: this.cardsToString(this.game.cards[index]) }) + '\n'
                    + this.strings.player.passed;
      return await interaction.update({ content });
    }
    throw new HZGError(ErrorCodes.InvalidButtonInteraction);
  }

  protected async playerSelect(interaction: SelectMenuInteraction): Promise<void> {
    const index = this.game.playerManager.getIndex(interaction.user.id);
    if (index < 0) return;

    let content = format(this.strings.player.cards, { cards: this.cardsToString(this.game.cards[index]) }) + '\n';
    if (interaction.user.id !== this.game.playerManager.nowPlayer.id) {
      content += this.strings.player.notYourTurn;
      return await interaction.update({ content });
    }

    const cards = interaction.values.map(c => parseInt(c, 10)).sort((a, b) => a - b);
    const trick = this.game.cardsToTrick(cards);
    if (!this.game.playable(trick)) {
      content += format(this.strings.player.invalid, { cards: this.cardsToString(cards) });
      return await interaction.update({ content });
    }

    this.bundles[index].selectedCards = cards;
    content += format(this.strings.player.selected, { cards: this.cardsToString(cards), trick: this.trickToString(trick) });
    await interaction.update({ content });
  }

  protected idleToDo(nowPlayer: Player): DjsInputResult {
    nowPlayer.status.set("IDLE");
    this.game.pass();
    return {
      content: format(this.strings.previous.idle, { player: nowPlayer.username }), 
    };
  }

  protected buttonToDo(): DjsInputResult {
    throw new HZGError(ErrorCodes.InvalidButtonInteraction);
  }

  protected messageToDo(): DjsInputResult {
    return {};
  }

  protected playToDo(nowPlayer: Player, input: number[]): DjsInputResult {
    nowPlayer.status.set("PLAYING");

    let content = '';
    let endStatus = "";
    if (!input.length) {
      content = format(this.strings.previous.pass, { player: nowPlayer.username });
    }
    else {
      if (this.game.win()) {
        this.winner = nowPlayer;
        endStatus = "WIN";
      }
      content = format(this.strings.previous.play, { player: nowPlayer.username, trick: this.trickToString(this.game.cardsToTrick(input)) });
    }

    return {
      content, 
      endStatus
    };
  }

  protected async botMove(): Promise<DjsInputResult> {
    throw new HZGError(ErrorCodes.BotsNotAllowed);
  }

  protected async update(result: DjsInputResult): Promise<DjsInputResult> {
    if (!this.mainMessage) {
      throw new HZGError(ErrorCodes.InvalidMainMessage);
    }

    this.game.playerManager.next();
    result.content = format(this.strings.nowPlayer, { player: `<@${this.game.playerManager.nowPlayer.id}>` }) + '\n'
                   + result.content + '\n' + format(this.strings.cardsOnTable, { cards: this.cardsToString(this.game.currentCards) });
    await this.mainMessage.edit(result).catch(() => {
      result.endStatus = "DELETED";
    });
    return result;
  }

  protected async end(status: string): Promise<void> {
    this.game.end(status);

    const content = format(this.strings.cardsOnTable, { cards: this.cardsToString(this.game.currentCards) });
    await this.mainMessage?.edit({ content: content, components: [] }).catch(() => {});
  }


  private getOptions(cards: number[]): MessageSelectOptionData[] {
    return cards.map(c => ({ label: this.cardToString(c), value: `${c}` }));
  }

  private async getBigTwoInput(): Promise<number[] | null> {
    // Since awaitMessageComponent() may reject, a must-resolving Promise is needed
    const promises: Promise<number[] | null>[] = [sleep(this.time, null)];

    promises.push(new Promise(resolve => {
      this.conveyor.on('playerLeft', () => {
        resolve(null);
      });
    }));

    promises.push(new Promise(resolve => {
      this.conveyor.on('cardsPlayed', cards => {
        resolve(cards);
      });
    }));
    
    const result = await Promise.any(promises);
    this.conveyor.removeAllListeners('cardsPlayed').removeAllListeners('playerLeft');
    return result;
  }

  private cardToString(card: number): string {
    return `${this.strings.ranks[card >> 2]}${this.strings.suits[card & 3]}`;
  }

  private cardsToString(cards: number[]): string {
    return cards.map(c => this.cardToString(c)).join(' ');
  }

  private trickToString(trick: BigTwoTrick): string {
    const { tricks } = this.strings;
    switch (trick[0]) {
      case BigTwoTrickType.None:
        return tricks.none;
      case BigTwoTrickType.Single:
        return format(tricks.single, { card: this.cardToString(trick[1]) });
      case BigTwoTrickType.Pair:
        return format(tricks.pair, { rank: this.strings.ranks[trick[1] >> 2] });
      case BigTwoTrickType.Straight:
        return format(tricks.straight, { rank: this.strings.ranks[trick[1] >> 2] });
      case BigTwoTrickType.FullHouse:
        return format(tricks.fullHouse, { rank: this.strings.ranks[trick[1] >> 2] });
      case BigTwoTrickType.FourOfAKind:
        return format(tricks.fourOfAKind, { rank: this.strings.ranks[trick[1] >> 2] });
      case BigTwoTrickType.StraightFlush:
        return format(tricks.straightFlush, { rank: this.strings.ranks[trick[1] >> 2] });
    }
  }
}