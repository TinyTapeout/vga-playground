/*
 * Copyright (c) 2025 Uri Shaked
 * SPDX-License-Identifier: Apache-2.0
 */

`default_nettype none

module tt_um_vga_example (
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

  // Tiny VGA Pmod
  assign uo_out = {hsync, B[0], G[0], R[0], vsync, B[1], G[1], R[1]};

  // Gamepad Pmod
  wire inp_b, inp_y, inp_select, inp_start, inp_up, inp_down, inp_left, inp_right, inp_a, inp_x, inp_l, inp_r;

  hvsync_generator vga_sync_gen (
      .clk(clk),
      .reset(~rst_n),
      .hsync(hsync),
      .vsync(vsync),
      .display_on(video_active),
      .hpos(pix_x),
      .vpos(pix_y)
  );

  gamepad_pmod_single driver (
      // Inputs:
      .rst_n(rst_n),
      .clk(clk),
      .pmod_data(ui_in[6]),
      .pmod_clk(ui_in[5]),
      .pmod_latch(ui_in[4]),
      // Outputs:
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

  // Colors
  localparam [5:0] BLACK = {2'b00, 2'b00, 2'b00};
  localparam [5:0] GREEN = {2'b00, 2'b11, 2'b00};
  localparam [5:0] WHITE = {2'b11, 2'b11, 2'b11};

  // Glyph definitions (8x8)
  localparam [7:0] LEFT_GLYPH[0:7] = '{
      8'b00010000,
      8'b00110000,
      8'b01110000,
      8'b11111111,
      8'b01110000,
      8'b00110000,
      8'b00010000,
      8'b00000000
  };
  localparam [7:0] RIGHT_GLYPH[0:7] = '{
      8'b00001000,
      8'b00001100,
      8'b00001110,
      8'b11111111,
      8'b00001110,
      8'b00001100,
      8'b00001000,
      8'b00000000
  };
  localparam [7:0] UP_GLYPH[0:7] = '{
      8'b00010000,
      8'b00111000,
      8'b01111100,
      8'b11111110,
      8'b00010000,
      8'b00010000,
      8'b00010000,
      8'b00010000
  };
  localparam [7:0] DOWN_GLYPH[0:7] = '{
      8'b00010000,
      8'b00010000,
      8'b00010000,
      8'b00010000,
      8'b11111110,
      8'b01111100,
      8'b00111000,
      8'b00010000
  };
  localparam [7:0] A_GLYPH[0:7] = '{
      8'b00111100,
      8'b01100110,
      8'b01100110,
      8'b01111110,
      8'b01100110,
      8'b01100110,
      8'b01100110,
      8'b00000000
  };
  localparam [7:0] B_GLYPH[0:7] = '{
      8'b01111100,
      8'b01100110,
      8'b01100110,
      8'b01111100,
      8'b01100110,
      8'b01100110,
      8'b01111100,
      8'b00000000
  };
  localparam [7:0] X_GLYPH[0:7] = '{
      8'b11000011,
      8'b01100110,
      8'b00111100,
      8'b00011000,
      8'b00011000,
      8'b00111100,
      8'b01100110,
      8'b11000011
  };
  localparam [7:0] Y_GLYPH[0:7] = '{
      8'b11000011,
      8'b01100110,
      8'b00111100,
      8'b00011000,
      8'b00011000,
      8'b00011000,
      8'b00011000,
      8'b00011000
  };
  localparam [7:0] L_GLYPH[0:7] = '{
      8'b11100000,
      8'b11100000,
      8'b11100000,
      8'b11100000,
      8'b11100000,
      8'b11111110,
      8'b11111110,
      8'b00000000
  };
  localparam [7:0] R_GLYPH[0:7] = '{
      8'b11111100,
      8'b11100110,
      8'b11100110,
      8'b11111100,
      8'b11111000,
      8'b11111100,
      8'b11101110,
      8'b00000000
  };
  localparam [7:0] SELECT_GLYPH[0:7] = '{
      8'b00011000,
      8'b00100100,
      8'b01000010,
      8'b10000001,
      8'b10000001,
      8'b01000010,
      8'b00100100,
      8'b00011000
  };
  localparam [7:0] START_GLYPH[0:7] = '{
      8'b00011000,
      8'b01011010,
      8'b10011001,
      8'b10011001,
      8'b10011001,
      8'b10000001,
      8'b01000010,
      8'b00111100
  };

  // Glyph positions
  localparam LEFT_X = 64, LEFT_Y = 240;
  localparam RIGHT_X = 128, RIGHT_Y = 240;
  localparam UP_X = 96, UP_Y = 200;
  localparam DOWN_X = 96, DOWN_Y = 280;
  localparam A_X = 544, A_Y = 240;
  localparam B_X = 512, B_Y = 280;
  localparam X_X = 512, X_Y = 200;
  localparam Y_X = 480, Y_Y = 240;
  localparam L_X = 32, L_Y = 100;
  localparam R_X = 592, R_Y = 100;
  localparam SEL_X = 264, SEL_Y = 240;
  localparam STRT_X = 328, STRT_Y = 240;

  // Glyph activation logic
  wire left_act = glyph_active(LEFT_X, LEFT_Y, LEFT_GLYPH);
  wire right_act = glyph_active(RIGHT_X, RIGHT_Y, RIGHT_GLYPH);
  wire up_act = glyph_active(UP_X, UP_Y, UP_GLYPH);
  wire down_act = glyph_active(DOWN_X, DOWN_Y, DOWN_GLYPH);
  wire a_act = glyph_active(A_X, A_Y, A_GLYPH);
  wire b_act = glyph_active(B_X, B_Y, B_GLYPH);
  wire x_act = glyph_active(X_X, X_Y, X_GLYPH);
  wire y_act = glyph_active(Y_X, Y_Y, Y_GLYPH);
  wire l_act = glyph_active(L_X, L_Y, L_GLYPH);
  wire r_act = glyph_active(R_X, R_Y, R_GLYPH);
  wire sel_act = glyph_active(SEL_X, SEL_Y, SELECT_GLYPH);
  wire strt_act = glyph_active(STRT_X, STRT_Y, START_GLYPH);

  // Pressed state logic
  wire any_active = left_act | right_act | up_act | down_act | a_act | b_act |
                   x_act | y_act | l_act | r_act | sel_act | strt_act;
  wire any_pressed = (left_act & inp_left) | (right_act & inp_right) | 
                    (up_act & inp_up) | (down_act & inp_down) |
                    (a_act & inp_a) | (b_act & inp_b) |
                    (x_act & inp_x) | (y_act & inp_y) |
                    (l_act & inp_l) | (r_act & inp_r) |
                    (sel_act & inp_select) | (strt_act & inp_start);

  // RGB output logic
  always @(posedge clk) begin
    if (~rst_n) begin
      R <= 0;
      G <= 0;
      B <= 0;
    end else begin
      if (video_active) begin
        {R, G, B} <= any_pressed ? GREEN : any_active ? WHITE : BLACK;
      end else begin
        {R, G, B} <= 0;
      end
    end
  end

  // Scaled glyph activation function (2x size)
  function glyph_active;
    input [9:0] x0, y0;
    input [7:0] glyph[0:7];
    reg [9:0] x_rel, y_rel;
    reg [7:0] row;
    begin
      if ((pix_x >= x0) && (pix_x < x0 + 16) && (pix_y >= y0) && (pix_y < y0 + 16)) begin
        x_rel = (pix_x - x0) >> 1;  // Scale coordinates
        y_rel = (pix_y - y0) >> 1;
        row = glyph[y_rel];
        glyph_active = row[7-x_rel];
      end else begin
        glyph_active = 0;
      end
    end
  endfunction

endmodule
