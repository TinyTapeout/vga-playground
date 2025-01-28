/*
 * Copyright (c) 2024 Ciro Cattuto
 * based on the VGA examples by Uri Shaked
 * and on tt07-conway-term (https://github.com/ccattuto/tt07-conway-term)
 * SPDX-License-Identifier: Apache-2.0
 */

`default_nettype none

module tt_um_gaming_pmod_demo(
  input  wire [7:0] ui_in,    // Dedicated inputs
  output wire [7:0] uo_out,   // Dedicated outputs
  input  wire [7:0] uio_in,   // IOs: Input path
  output wire [7:0] uio_out,  // IOs: Output path
  output wire [7:0] uio_oe,   // IOs: Enable path (active high: 0=input, 1=output)
  input  wire       ena,      // always 1 when the design is powered, so you can ignore it
  input  wire       clk,      // clock
  input  wire       rst_n     // reset_n - low to reset
);

  // VGA signals
  wire hsync;
  wire vsync;
  reg [1:0] R;
  reg [1:0] G;
  reg [1:0] B;
  wire video_active;
  wire [9:0] pix_x;
  wire [9:0] pix_y;

  // TinyVGA PMOD
  assign uo_out  = {hsync, B[0], G[0], R[0], vsync, B[1], G[1], R[1]};

  // Game controller
  wire [11:0] game_controller_pmod_data;
  wire inp_b;
  wire inp_y;
  wire inp_select;
  wire inp_start;
  wire inp_up;
  wire inp_down;
  wire inp_left;
  wire inp_right;
  wire inp_a;
  wire inp_x;
  wire inp_l;
  wire inp_r;

  wire left_stripe = inp_left && pix_x < 50;
  wire right_stripe = inp_right && pix_x >= 50 && pix_x < 100;
  wire up_stripe = inp_up && pix_x >= 100 && pix_x < 150;
  wire down_stripe = inp_down && pix_x >= 150 && pix_x < 200;
  wire a_stripe = inp_a && pix_x >= 200 && pix_x < 250;
  wire b_stripe = inp_b && pix_x >= 250 && pix_x < 300;


  hvsync_generator vga_sync_gen (
    .clk(clk),
    .reset(~rst_n),
    .hsync(hsync),
    .vsync(vsync),
    .display_on(video_active),
    .hpos(pix_x),
    .vpos(pix_y)
  );

  game_controller_pmod_driver driver (
    .rst_n(rst_n),
    .clk(clk),
    .pmod_data(ui_in[6]),
    .pmod_clk(ui_in[5]),
    .pmod_latch(ui_in[4]),
    .data_reg(game_controller_pmod_data)
  );

  game_controller_pmod_decoder decoder (
    .data_reg(game_controller_pmod_data),
    .b(inp_b),
    .y(inp_y),
    .select(inp_select),
    .start(inp_start),
    .up(inp_up),
    .down(inp_down),
    .left(inp_left),
    .right(inp_right),
    .a(inp_a),
    .x(inp_x),
    .l(inp_l),
    .r(inp_r)
  );

  // RGB output logic
  always @(posedge clk) begin
    if (~rst_n) begin
      R <= 0;
      G <= 0;
      B <= 0;
    end else begin
      R <= video_active && (left_stripe || down_stripe || b_stripe) ? 2'b11 : 0;
      G <= video_active && (right_stripe || down_stripe || a_stripe) ? 2'b11 : 0;
      B <= video_active && (up_stripe || a_stripe || b_stripe) ? 2'b11 : 0;
    end
  end

endmodule


module game_controller_pmod_decoder (
    input wire [11:0] data_reg,
    output wire b,
    output wire y,
    output wire select,
    output wire start,
    output wire up,
    output wire down,
    output wire left,
    output wire right,
    output wire a,
    output wire x,
    output wire l,
    output wire r
);

  // SNES controller mapping (12 bits):
  assign {b, y, select, start, up, down, left, right, a, x, l, r} = data_reg;

endmodule


module game_controller_pmod_driver #(
    parameter BIT_WIDTH = 12
) (
    input wire rst_n,
    input wire clk,
    input wire pmod_data,
    input wire pmod_clk,
    input wire pmod_latch,
    output reg [BIT_WIDTH-1:0] data_reg
);

  reg pmod_clk_prev;
  reg pmod_latch_prev;
  reg [BIT_WIDTH-1:0] shift_reg;

  // sync pmod signals to the clk domain:
  reg [1:0] pmod_data_sync;
  reg [1:0] pmod_clk_sync;
  reg [1:0] pmod_latch_sync;

  always @(posedge clk) begin
    if (~rst_n) begin
      pmod_data_sync  <= 2'b0;
      pmod_clk_sync   <= 2'b0;
      pmod_latch_sync <= 2'b0;
    end else begin
      pmod_data_sync  <= {pmod_data_sync[0], pmod_data};
      pmod_clk_sync   <= {pmod_clk_sync[0], pmod_clk};
      pmod_latch_sync <= {pmod_latch_sync[0], pmod_latch};
    end
  end

  // shift register for the pmod data
  always @(posedge clk) begin
    if (~rst_n) begin
      shift_reg <= 0;
      data_reg <= 0;
      pmod_clk_prev <= 1'b0;
      pmod_latch_prev <= 1'b0;
    end
    begin
      pmod_clk_prev   <= pmod_clk_sync[1];
      pmod_latch_prev <= pmod_latch_sync[1];

      if (pmod_latch_prev & ~pmod_latch_sync[1]) begin
        data_reg <= shift_reg;
      end
      if (pmod_clk_prev & ~pmod_clk_sync[1]) begin
        shift_reg <= {shift_reg[BIT_WIDTH-2:0], pmod_data_sync[1]};
      end
    end
  end

endmodule
