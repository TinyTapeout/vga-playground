/*
 * Copyright (c) 2025 Pat Deegan
 * https://psychogenic.com
 * SPDX-License-Identifier: Apache-2.0
 */

`default_nettype none


/*
 * game_controller: An individual controller, holding the buttons state
 * as interpreted based on the input data_reg.
 *
  * a not-present/disconnected controller will have 
 * is_present == 0, and all buttons will return as 0.
*/
module game_controller (
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
    output wire r,
    output wire is_present
);
  // if the data is all 1's, this indicates a 
  // disconnected controller
  // In that case, is_present will be 0, as will all the button
  // states returned
  wire reg_empty;
  assign reg_empty = (data_reg == 12'hfff);
  assign is_present = reg_empty ? 0 : 1'b1;
  assign {b, y, select, start, up, down, left, right, a, x, l, r} = reg_empty ? 0 : data_reg;

endmodule

/*
 * game_controller_pmod_driver: understands the protocol
 * received from the 3 pins on the PMOD (pmod_*)
 * This protocol returns state for 2 controllers, so 
 * 24 bits of data.
*/
module game_controller_pmod_driver #(
    parameter BIT_WIDTH = 24
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

      if (pmod_latch_sync[1] & ~pmod_latch_prev) begin
        // just went up, latch that data
        data_reg <= shift_reg;
      end
      if (~pmod_clk_sync[1] & pmod_clk_prev) begin
        // just went down, put the last data bit on the end
        // of the shift register
        shift_reg <= {shift_reg[BIT_WIDTH-2:0], pmod_data_sync[1]};
      end
    end
  end

endmodule


/*
 * game_controller_pmod -- main interface to the PMOD.
 * provides data for two controllers, through the various
 * state arrays below (start[1:0], up[1:0], etc.)
 * All the values for the first controller are at index 0
 * (up[0], y[0], etc) and for the second, at index 1.
 *
 * In addition to the button states, it provides an 
 * is_present array, to let you know if the given 
 * controller is actually connected (e.g. is_present[1] == 0
 * indicates that there's no second controller connected).
 *
 * Feed it the 3 wires coming in from the PMOD, 
 * pmod_data, pmod_clk, and pmod_latch, and then 
 * enjoy all the button presses.
*/
module game_controller_pmod (
    input wire rst_n,
    input wire clk,
    input wire pmod_data,
    input wire pmod_clk,
    input wire pmod_latch,
    
    
    output wire [1:0] b,
    output wire [1:0] y,
    output wire [1:0] select,
    output wire [1:0] start,
    output wire [1:0] up,
    output wire [1:0] down,
    output wire [1:0] left,
    output wire [1:0] right,
    output wire [1:0] a,
    output wire [1:0] x,
    output wire [1:0] l,
    output wire [1:0] r,
    output wire [1:0] is_present

);

  // game_controller_pmod_data -- holds the 
  // all the bits for both controllers, latched
  // from the pmod
  wire [23:0] game_controller_pmod_data;
  
  // the driver interprets the protocol 
  // and sets the contents of game_controller_pmod_data
  game_controller_pmod_driver driver (
    .rst_n(rst_n),
    .clk(clk),
    .pmod_data(pmod_data),
    .pmod_clk(pmod_clk),
    .pmod_latch(pmod_latch),
    .data_reg(game_controller_pmod_data)
  );
  
  // 2 game_controllers decode their respective 
  // data blobs into the up/down/left/right/a/x...
  // states
  game_controller decoder1 (
    .data_reg(game_controller_pmod_data[11:0]),
    .b(b[0]),
    .y(y[0]),
    .select(select[0]),
    .start(start[0]),
    .up(up[0]),
    .down(down[0]),
    .left(left[0]),
    .right(right[0]),
    .a(a[0]),
    .x(x[0]),
    .l(l[0]),
    .r(r[0]),
    .is_present(is_present[0])
  );
  
  
  game_controller decoder2 (
    .data_reg(game_controller_pmod_data[23:12]),
    .b(b[1]),
    .y(y[1]),
    .select(select[1]),
    .start(start[1]),
    .up(up[1]),
    .down(down[1]),
    .left(left[1]),
    .right(right[1]),
    .a(a[1]),
    .x(x[1]),
    .l(l[1]),
    .r(r[1]),
    .is_present(is_present[1])
  );
  

endmodule

