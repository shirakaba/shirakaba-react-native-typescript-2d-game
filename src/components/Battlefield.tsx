// Copyright © 2018 Jamie Birch
// Licensed under GPL; find at repo root, in LICENSE.txt.

import React, {Component} from 'react';
import { GestureResponderEvent, ScaledSize, StyleSheet, View} from 'react-native';
import { Loop, Stage } from 'react-game-kit/native';
import {Box, BoxId, BoxTransforms} from "./Box";
import {
    ComponentStyle,
    getPotentiallyUnoccupiedPoint, getPotentiallyUnoccupiedPointWithinWindow,
    isColliding,
    milliseconds,
    Point,
    Size,
    StyleObject,
    Zone
} from "../utils/utils";
import PropTypes from 'prop-types';
import {Item, ItemProps, ITEM_LENGTH, ItemType} from "./Item";
import {DimensionsState} from "../../App";
import {StateBatcher} from "../utils/StateBatcher";
import {GameOverModal} from './GameOverModal';

type BattlefieldProps = Props & DimensionsState;

interface Props {
}

type BattlefieldState = BoxStates & CollisionState & TimeState & BattlefieldDimensionsState & ItemStates & GameState;

interface GameState {
    gameOver: boolean,
    timeSurvived: milliseconds
}

interface BattlefieldDimensionsState {
    stageWidth: number;
    stageHeight: number;
}

interface CollisionState {
    colliding: boolean
}

interface BoxStates {
    redBoxTransform: BoxTransforms,
    redBoxSpeed: number,
    // red box will ALWAYS target blue's latest position.
    redBoxLength: number,
    blueBoxTransform: BoxTransforms,
    blueBoxTargetLocation: Point,
    blueBoxSpeed: number
}

interface ItemStates {
    items: ItemProps[];
    teleportVillain: boolean;
}

interface TimeState {
    lastFrameDate: number;
    currentFrameDate: number;
}

type BatchedStateComparativeCallback = (prevState: Readonly<BattlefieldState>, props: BattlefieldProps) => Partial<BattlefieldState>;

const deviceFramerate: number = 60; // TODO: get proper number from device info.
const LOSE_GAME_UPON_COLLISION: boolean = true;

export class Battlefield extends Component<BattlefieldProps, BattlefieldState> {
    private frameNo: number = 0;
    private blueBoxLength: number = 25;
    private redBoxInitialLength: number = 50;
    private redBoxSizeLimit: number = 200;
    private stateBatcher: StateBatcher<BattlefieldProps, BattlefieldState> = new StateBatcher<BattlefieldProps, BattlefieldState>(this.setState.bind(this));
    private scaleInterval: number;
    private itemRestoreTimeouts: number[] = [];
    private itemRestoreTime: milliseconds = 3000;
    private startGameState: BattlefieldState;
    private loopID: number;

    static contextTypes = {
        loop: PropTypes.object,
    };

    private generateNewGameState(windowDimensions: ScaledSize, forceRedBoxToAvoidNavigationSegue: boolean = false): BattlefieldState {
        const blueInitialLeft: number = windowDimensions.width / 2;
        const blueInitialTop: number = windowDimensions.height / 2;

        const blueBoxTransform: BoxTransforms = {
            left: blueInitialLeft,
            top: blueInitialTop,
            rotation: 0
        };

        const date: number = Date.now();
        return {
            gameOver: false,
            timeSurvived: 0,
            items: this.mapItemTypesToItemStates(
                {
                    left: blueBoxTransform.left,
                    top: blueBoxTransform.top,
                    width: this.blueBoxLength,
                    height: this.blueBoxLength,
                },
                {
                    width: ITEM_LENGTH,
                    height: ITEM_LENGTH
                }
            ),
            teleportVillain: false,
            stageWidth: windowDimensions.width,
            stageHeight: windowDimensions.height,
            lastFrameDate: date,
            currentFrameDate: date,
            colliding: false,
            redBoxTransform: {
                ...Box.generateRandomOffscreenBoxPosition(this.redBoxInitialLength, this.props.portrait, windowDimensions, forceRedBoxToAvoidNavigationSegue),
                rotation: 0
            },
            redBoxLength: this.redBoxInitialLength,
            redBoxSpeed: 3,
            blueBoxSpeed: 5,
            blueBoxTransform,
            blueBoxTargetLocation: {
                left: blueInitialLeft,
                top: blueInitialTop
            }
        };
    }

    constructor(props: BattlefieldProps) {
        super(props);

        this.state = this.startGameState = this.generateNewGameState(this.props.windowDimensions, true);

        this.update = this.update.bind(this);
    }

    private resetGame(): void {
        // console.log("RESET GAME");

        this.stateBatcher.batchedState = this.startGameState = this.generateNewGameState(this.props.windowDimensions);
        this.stateBatcher.clearBatch();

        // console.log(
        //     // "[resetGame()] this.stateBatcher.batchedState",
        //     this.stateBatcher.batchedState
        // );

        this.setState(
            this.startGameState,
            () => {
                // console.log(`CALLING BACK WITH STARTGAME(). timeSurvived: ${this.state.timeSurvived}`);
                this.startGame();
            }
        );
    }

    private gameOver(): void {
        // console.log("GAME OVER");
        this.setState({
            gameOver: true
        });

        this.cleanUp.call(this);
    }

    /**
     * Called each frame of the game loop.
     * Assesses the final state of the Battlefield each frame, based on the batches of state it has received by the time
     * it has been called, then ultimately sets the state, prompting a render. Finally resets the batchedState.
     */
    private update(): void {
        // console.log("UPDATE");
        this.frameNo++;

        this.stateBatcher.batchState(
            (prevState: Readonly<BattlefieldState>, props: BattlefieldProps) => {
                const currentFrameDate: number = Date.now();
                // console.log(`${prevState.timeSurvived + (prevState.currentFrameDate - prevState.lastFrameDate)}`);
                // console.log(`prevState.timeSurvived: ${prevState.timeSurvived}`);
                return {
                    currentFrameDate: currentFrameDate,
                    lastFrameDate: prevState.currentFrameDate,
                    timeSurvived: prevState.timeSurvived + (currentFrameDate - prevState.currentFrameDate)
                }
            }
        );

        if(this.stateBatcher.batchedState.redBoxTransform || this.stateBatcher.batchedState.blueBoxTransform){
            // console.log(
            //     // "[update()] this.stateBatcher.batchedState",
            //     this.stateBatcher.batchedState
            // );

            const redBoxTransform: Point = this.stateBatcher.batchedState.redBoxTransform || this.state.redBoxTransform;
            const redBoxLength: number = this.stateBatcher.batchedState.redBoxLength || this.state.redBoxLength;
            const blueBoxTransform: Point = this.stateBatcher.batchedState.blueBoxTransform || this.state.blueBoxTransform;

            // TODO: reduce red box's collision size when it's rotated
            const colliding: boolean = isColliding(
                {
                    ...redBoxTransform,
                    width: redBoxLength,
                    height: redBoxLength
                },
                {
                    ...blueBoxTransform,
                    width: this.blueBoxLength,
                    height: this.blueBoxLength
                }
            );

            if(colliding){
                this.stateBatcher.batchState({
                    colliding: true
                });

                if(LOSE_GAME_UPON_COLLISION) this.gameOver.call(this);
            }
        }

        this.stateBatcher.setStateBatch();
    };

    private startGame(): void {
        // console.log("START GAME. state:", this.state);
        // The moment we subscribe to the loop again, we see the GAME OVER message, because update() runs and somehow box positions haven't yet been reset.
        this.loopID = this.context.loop.subscribe(this.update);
        this.beginTimedEvents();
    }

    private beginTimedEvents(): void {
        this.scaleInterval = window.setInterval(
            () => {
                if (this.state.redBoxLength === this.redBoxSizeLimit) return;
                this.stateBatcher.batchState(
                    (prevState: Readonly<BattlefieldState>, props: BattlefieldProps) => ({
                        redBoxLength: prevState.redBoxLength + 1
                    })
                );
            },
            200
        );
    }

    /**
     * Any tasks that may have side-effects (e.g. setState()) are recommended to be done here rather than in constructor:
     * https://stackoverflow.com/a/40832293/5951226
     */
    componentDidMount(): void {
        this.startGame();
    }

    private cleanUp(): void {
        // console.log("CLEAN UP");

        // this.context.loop.unsubscribe(this.update); // WARNING: Seems to be an undocumented change in the react-game-kit API; you've got to hand in the ID yourself.
        this.context.loop.unsubscribe(this.loopID); // See react-game-kit for (limited) documentation. Not a Promise.

        clearInterval(this.scaleInterval);
        this.itemRestoreTimeouts.forEach((timeout: number) => clearInterval(timeout));
    }

    componentWillUnmount(): void {
        this.cleanUp();
    }

    onResponderGrant(ev: GestureResponderEvent): void {
        if(!this.state.gameOver && !this.stateBatcher.batchedState.gameOver) this.updateBlueBoxTarget(ev.nativeEvent.pageX, ev.nativeEvent.pageY);
    }

    // Fired less frequently than screen update, at least for iOS simulator.
    onResponderMove(ev: GestureResponderEvent): void {
        if(!this.state.gameOver && !this.stateBatcher.batchedState.gameOver) this.updateBlueBoxTarget(ev.nativeEvent.pageX, ev.nativeEvent.pageY);
    }

    onPositionUpdate(id: BoxId, left: number, top: number, rotation: number): void {
        switch(id){
            case BoxId.Villain:
                this.stateBatcher.batchState({
                    redBoxTransform: {
                        left,
                        top,
                        rotation
                    }
                });
                break;
            case BoxId.Hero:
                const stateBatch: Partial<Pick<BattlefieldState, "blueBoxTransform"|"items"|"blueBoxSpeed"|"redBoxLength">> = {
                    blueBoxTransform: {
                        left,
                        top,
                        rotation
                    }
                };

                (this.stateBatcher.batchedState.items || this.state.items)
                .forEach((item: ItemProps, i: number, items: ItemProps[]) => {
                    // This is an obvious use case for filter(), but we use forEach() to keep the index into the unfiltered array.
                    if(items[i].consumed) return;

                    const isConsumed: boolean = isColliding(
                        {
                            left,
                            top,
                            width: this.blueBoxLength,
                            height: this.blueBoxLength
                        },
                        {
                            left: item.left,
                            top: item.top,
                            width: ITEM_LENGTH,
                            height: ITEM_LENGTH,
                        }
                    );

                    if(!isConsumed) return;
                    // console.log(`Consumed item[${i}]; type ${item.type}!`);

                    // We only deep copy the items once we identify that we have to.
                    if(typeof stateBatch.items === "undefined") stateBatch.items = JSON.parse(JSON.stringify(items));
                    stateBatch.items[i].consumed = true;

                    Item.playSound(item.type).catch((e: any) => console.error(e));
                    switch(item.type){
                        case ItemType.Speed:
                            // TODO: limit this so that the blue box can't travel further than his body length in one frame (otherwise he'll skip through items)
                            // stateBatch.blueBoxSpeed = (this.stateBatcher.batchedState.blueBoxSpeed || this.state.blueBoxSpeed) + 10;
                            this.stateBatcher.batchState((prevState: Readonly<BattlefieldState>, props: BattlefieldProps) => ({ blueBoxSpeed: prevState.blueBoxSpeed + 5 }));
                            break;
                        case ItemType.Shrink:
                            // stateBatch.redBoxLength = Math.max(this.redBoxInitialLength, (this.stateBatcher.batchedState.redBoxLength || this.state.redBoxLength) - 50);
                            this.stateBatcher.batchState((prevState: Readonly<BattlefieldState>, props: BattlefieldProps) => ({ redBoxLength:  Math.max(this.redBoxInitialLength, prevState.redBoxLength - 100) }));
                            break;
                        case ItemType.Teleport:
                            this.stateBatcher.batchState(
                                (prevState: Readonly<BattlefieldState>, props: BattlefieldProps) => {
                                    return {
                                        redBoxTransform: {
                                            ...Box.generateRandomOffscreenBoxPosition(prevState.redBoxLength, props.portrait, props.windowDimensions),
                                            rotation: prevState.redBoxTransform.rotation
                                        },
                                        teleportVillain: true
                                    }
                                },
                                () => {
                                    this.stateBatcher.batchState({ teleportVillain: false });
                                }
                            );
                            break;
                        case ItemType.Mine:
                            // stateBatch.blueBoxSpeed = Math.max(1, (this.stateBatcher.batchedState.blueBoxSpeed || this.state.blueBoxSpeed) - 10);
                            this.stateBatcher.batchState((prevState: Readonly<BattlefieldState>, props: BattlefieldProps) => ({ blueBoxSpeed:  Math.max(1, prevState.blueBoxSpeed - 3) }));
                            break;
                    }

                    this.restoreItem(i);
                });

                this.stateBatcher.batchState(stateBatch);
                break;
            default:
                break;
        }
    }

    // TODO: Remedy this naive implementation, which may suffer race conditions.
    private restoreItem(index: number): void {
        this.itemRestoreTimeouts[index] = window.setTimeout(
            () => {
                const items: ItemProps[] = JSON.parse(JSON.stringify((this.stateBatcher.batchedState.items || this.state.items)));
                items[index].consumed = false;

                const point: Point = getPotentiallyUnoccupiedPointWithinWindow(
                    {
                        left: this.state.blueBoxTransform.left,
                        top: this.state.blueBoxTransform.top,
                        width: this.blueBoxLength,
                        height: this.blueBoxLength,
                    },
                    {
                        width: ITEM_LENGTH,
                        height: ITEM_LENGTH
                    },
                    this.props.portrait,
                    this.props.screenDimensions,
                    this.props.windowDimensions
                );

                items[index].left = point.left;
                items[index].top = point.top;

                this.stateBatcher.batchState({
                    items
                });
            },
            this.itemRestoreTime
        );
    }

    // applySpeedBonusToHero(): void {
    //     this.setState((prevState: Readonly<BattlefieldState>, props: BattlefieldProps) => ({ speed: prevState.speed + 10 }));
    // }

    // shouldComponentUpdate(nextProps: Readonly<BattlefieldProps>, nextState: Readonly<BattlefieldState>, nextContext: any): boolean {
    //     if(nextProps === this.props && nextState === this.state) return false;
    //
    //     // Visual props
    //     if(this.props.windowDimensions !== nextProps.windowDimensions) return true;
    //
    //     // Visual state
    //     // TODO: tell Battlefield to stop updating upon game-over (which hasn't been implemented yet).
    //     // if(this.state.gameOver) return false;
    //     // Pretty much all the Battlefield's state is visual, so no great saving to be made by doing deep comparisons.
    //
    //     return true;
    // }

    /**
     * The blue box will advance towards this target location once per frame at a rate based on its 'speed' prop.
     * The distance of advance each frame is dependent on time elapsed, and so will compensate if frames are dropped.
     */
    updateBlueBoxTarget(left: number, top: number): void {
        this.stateBatcher.batchState({
            blueBoxTargetLocation: {
                left: left - this.blueBoxLength/2,
                top: top - this.blueBoxLength/2
            }
        });
    }

    private mapItemTypesToItemStates(forbiddenZone: Zone, itemSize: Size): ItemProps[] {
        // Iterating over TypeScript enums: https://stackoverflow.com/a/21294925/5951226
        return Object.keys(ItemType)
        .filter((key: string) => typeof ItemType[key] === "number")
        .map((key: string, i: number) => {
            const unoccupiedPoint: Point = getPotentiallyUnoccupiedPointWithinWindow(
                forbiddenZone,
                itemSize,
                this.props.portrait,
                this.props.screenDimensions,
                this.props.windowDimensions
            );
            return {
                type: ItemType[key],
                ...unoccupiedPoint,
                consumed: false,
            };
        })
    }

    render() {
        const dynamicCollisionIndicatorStyle: Partial<ComponentStyle> = {
            color: this.state.colliding ? "red" : "green"
        };

        const blueCentredTargetLeft: number = this.state.blueBoxTransform.left + this.blueBoxLength/2 - this.state.redBoxLength/2;
        const blueCentredTargetTop: number = this.state.blueBoxTransform.top + this.blueBoxLength/2 - this.state.redBoxLength/2;

        // console.log("RENDERING. TIMESURVIVED:", this.state.timeSurvived);

        return (
            <View
                style={styles.container}
                onStartShouldSetResponder={(ev: GestureResponderEvent) => true}
                onResponderGrant={this.onResponderGrant.bind(this)}
                onResponderMove={this.onResponderMove.bind(this)}
            >
                { this.state.items.map((item: ItemProps, i: number, items: ItemProps[]) => <Item key={i} type={item.type} left={item.left} top={item.top} consumed={items[i].consumed}/>) }
                <Box
                    id={BoxId.Villain}
                    currentFrameDate={this.state.currentFrameDate}
                    lastFrameDate={this.state.lastFrameDate}
                    speed={this.state.redBoxSpeed / (1000 / deviceFramerate)}
                    size={this.state.redBoxLength}
                    colour={"red"}
                    left={(this.state.timeSurvived === 0 || this.state.teleportVillain) ? (this.state.redBoxTransform.left) : null}
                    top={(this.state.timeSurvived === 0 || this.state.teleportVillain) ? (this.state.redBoxTransform.top) : null}
                    targetLeft={blueCentredTargetLeft}
                    targetTop={blueCentredTargetTop}
                    onPositionUpdate={this.onPositionUpdate.bind(this)}
                    gameOver={this.state.gameOver}
                />
                <Box
                    id={BoxId.Hero}
                    currentFrameDate={this.state.currentFrameDate}
                    lastFrameDate={this.state.lastFrameDate}
                    speed={this.state.blueBoxSpeed / (1000 / deviceFramerate)}
                    size={this.blueBoxLength}
                    colour={"blue"}
                    left={this.state.timeSurvived === 0 ? this.state.blueBoxTransform.left : null}
                    top={this.state.timeSurvived === 0 ? this.state.blueBoxTransform.top : null}
                    targetLeft={this.state.blueBoxTargetLocation.left}
                    targetTop={this.state.blueBoxTargetLocation.top}
                    onPositionUpdate={this.onPositionUpdate.bind(this)}
                    gameOver={this.state.gameOver}
                />
                <GameOverModal
                    modalVisible={this.state.gameOver}
                    timeSurvived={this.stateBatcher.batchedState.timeSurvived || this.state.timeSurvived}
                    resetGame={this.resetGame.bind(this)}
                />
            </View>
        );
    }
}

const styles: StyleObject = StyleSheet.create<StyleObject>({
    container: {
        // flex: 1,
        // justifyContent: "center",
        // alignItems: "center",
        position: 'absolute',
        height: "100%",
        width: "100%",
        backgroundColor: 'orange'
    }
});
